# Người D — Digital Filter (Biquad/PT1) + IMU Pipeline

## Scope

| | |
|---|---|
| **File** | `Core/Src/Filter.c` (277 LOC), `Core/Src/main.c:577–629` (Filter_Init, IMU_PROCESS) |
| **Hàm chính** | `biquadFilterInit()`, `biquadFilterApply()`, `pt1FilterApply()`, `pt1FilterApply4()`, `Filter_Init()`, `IMU_PROCESS()` |
| **Vai trò** | DSP — lọc nhiễu motor + rung động ra khỏi tín hiệu IMU trước khi đưa vào AHRS/PID |

## Phải biết cold

### 1. Tại sao phải lọc IMU?
- Motor BLDC quay ~5000–15000 RPM → tần số rung 80–250 Hz đập vào gyro.
- Vibration cánh quạt (prop wash) → noise băng rộng.
- Acc rất nhạy với rung → đọc trực tiếp acc → AHRS chao đảo.
- ADC quantization noise → cao tần.

→ **Filter pipeline:** gyro qua **Notch motor + LPF**, acc qua **LPF nặng** → vào AHRS.

### 2. Sample rate và Nyquist
- BMI160 ODR = 1600 Hz nhưng project sample mỗi 600 µs (~1666 Hz) — gần như mọi sample đều "fresh".
- Nyquist = 833 Hz → cutoff filter phải <833 Hz; càng thấp càng mượt nhưng càng trễ.
- **Quy tắc**: cutoff = 0.05–0.1 × Nyquist cho gyro flight control → 80 Hz nằm trong vùng tốt.

### 3. Hai loại filter dùng

#### PT1 — Single-Pole Low-Pass (Filter.c:30–86)
```
       α
in ──►─[*]──┬──► out
            │
       state ◄ (one-step delay)
       
α = dT / (RC + dT)
RC = 1 / (2π·f_cut)
y[k] = y[k-1] + α·(x[k] - y[k-1])
```
- 1 multiply + 1 subtract + 1 add → cực rẻ, mỗi step ~3 cycle.
- Roll-off **−20 dB/decade** (chậm, nhưng phase shift nhỏ).
- Project dùng cho: vibration RMS (5 Hz, 2 Hz), error LPF trong PID.

#### Biquad — Second Order IIR (Filter.c:188–254)
```
y[k] = b0·x[k] + b1·x[k-1] + b2·x[k-2] − a1·y[k-1] − a2·y[k-2]
```
- 5 multiply + 4 add → ~10 cycle/sample trên Cortex-M4 FPU.
- Roll-off **−40 dB/decade** → gấp đôi PT1.
- 2 dạng: **LPF** (tabel sin/cos) hoặc **NOTCH** (khử band hẹp).

### 4. Direct Form II Transposed (DF2T)

Project dùng DF2T — chỉ cần 2 state thay vì 4.
```c
float biquadFilterApply(filter, x){
    y    = b0*x + filter->x1;
    x1_new = b1*x − a1*y + filter->x2;
    x2_new = b2*x − a2*y;
    filter->x1 = x1_new;
    filter->x2 = x2_new;
    return y;
}
```
- Ưu: tiết kiệm RAM (mỗi filter chỉ 5 float coeff + 2 state float = 28 byte).
- DF1 (commented `biquadFilterApplyDF1`) cần x1,x2,y1,y2 → 36 byte.

### 5. Coefficient calculation (Filter.c:188–231)

LPF Butterworth-like:
```
ω = 2π·f_c / fs
α = sin(ω) / (2Q)        // Q = 0.7071 cho LPF Butterworth
b0 = (1 − cos(ω))/2
b1 = 1 − cos(ω)
b2 = (1 − cos(ω))/2
a0 = 1 + α
a1 = −2·cos(ω)
a2 = 1 − α
// Normalize all by a0
```

Notch:
```
b0 = 1
b1 = −2·cos(ω)
b2 = 1
a0/a1/a2 = same
Q = filterFreq·cutoffHz / (filterFreq² − cutoffHz²)
```

### 6. Cấu hình filter trong project (main.c::Filter_Init)

```c
biquadFilterInitLPF (&gyro_lpf[i],   80,    GYRO_RATE_US);   // 80 Hz LPF
biquadFilterInitNotch(&gyro_notch[i], GYRO_RATE_US, 200, 70); // Notch 200 ±35 Hz
biquadFilterInitLPF (&acc_lpf[i],    10,    GYRO_RATE_US);   // 10 Hz LPF (acc nặng)
pt1FilterInit(&accVibeFloorFilter[i], 5.0f, dt);             // 5 Hz floor
pt1FilterInit(&accVibeFilter[i],      2.0f, dt);             // 2 Hz vibration env
```

| Filter | Tín hiệu | Cutoff | Mục đích |
|---|---|---|---|
| `gyro_notch` | Gyro | 200 Hz, BW 70 Hz | Khử motor harmonic chính |
| `gyro_lpf` | Gyro | 80 Hz | Khử nhiễu cao tần còn lại |
| `acc_lpf` | Acc | 10 Hz | Acc nhạy rung; AHRS cần signal mượt |
| `accVibeFloor` | acc | 5 Hz | Tín hiệu nền, baseline acc |
| `accVibe` | (acc-floor)² | 2 Hz | RMS rung động → input adaptive filter (chưa hiện thực) |

### 7. Pipeline đầy đủ trong `IMU_PROCESS()`

```c
for(i=0;i<3;i++){
    // (a) RMS vibration tracking
    accFloorFilt = pt1FilterApply(&accVibeFloorFilter[i], BMI160.acc[i]);
    accDiff      = raw_adc_acc[i] - accFloorFilt;          // [bug: dùng raw cũ]
    accVibeSq[i] = pt1FilterApply(&accVibeFilter[i], accDiff*accDiff);

    // (b) Gyro: notch motor → LPF 80 Hz → trừ bias
    gyro_filtered[i] = biquadFilterApply(&gyro_notch[i], BMI160.gyro[i]);
    gyro_filtered[i] = biquadFilterApply(&gyro_lpf[i], gyro_filtered[i])
                     - IMU_CALIBRATE.offset_gyro[i];

    // (c) Acc: LPF 10 Hz
    acc_filtered[i] = biquadFilterApply(&acc_lpf[i], BMI160.acc[i]);
}
accVibe = sqrt(accVibeSq[0] + accVibeSq[1] + accVibeSq[2]);
```

## Câu hỏi CƠ BẢN

| # | Câu | Hướng trả lời |
|---|---|---|
| 1 | "Filter là gì?" | Loại bỏ thành phần tần số không mong muốn; LPF giữ tần thấp, HPF giữ tần cao, notch khử 1 dải hẹp |
| 2 | "Biquad có nghĩa gì?" | "Bi" = 2 quadratic — tử và mẫu của hàm truyền là đa thức bậc 2 |
| 3 | "FIR vs IIR khác gì?" | FIR đáp ứng hữu hạn (taps), không feedback; IIR có feedback (a1,a2), bậc thấp đạt cùng performance nhưng có thể không ổn định |
| 4 | "Vì sao biquad project dùng IIR?" | Tiết kiệm cycle MCU; FIR cùng độ dốc cần ~30+ taps |
| 5 | "Notch là gì?" | Filter khử 1 tần số trung tâm (ở đây 200 Hz = motor RPM), băng rộng 70 Hz |
| 6 | "Q-factor là gì?" | Selectivity — Q cao = băng hẹp; Q = fc/BW = 200/70 ≈ 2.86 |
| 7 | "Cutoff 80 Hz cho gyro vì sao?" | Đáp ứng người dùng + sự kiện vật lý max ~30 Hz; trên đó là noise |
| 8 | "Sample rate 1666 Hz, vì sao chọn 600 µs?" | BMI160 ODR 1600 Hz; sample sát mỗi DRDY → tránh aliasing |

## Câu hỏi PHẢN BIỆN

### Q1. "Đặt notch tại 200 Hz cứng — nếu motor đổi RPM thì sao?"
**A:** Đúng, **đây là static notch — hạn chế lớn**. Khi throttle thay đổi → RPM thay đổi → motor harmonic dịch (vd 150 Hz lúc hover, 280 Hz lúc full throttle). Notch 200 Hz chỉ tốt ở 1 vùng.
**Giải pháp tiến bộ:** RPM-tracked notch (Betaflight) — đọc RPM từ ESC bidirectional DShot → dynamic notch frequency. Project chưa làm.
Project có `accVibe` để **đo level rung** nhưng chưa feed lại làm adaptive cutoff.

### Q2. "DF2T vs DF1 — cụ thể tiết kiệm gì?"
**A:** DF1 cần lưu x1,x2,y1,y2 (4 state) — 32 byte/filter. DF2T merge x và y thành 1 cặp state nội bộ (s1,s2 trong code) — 16 byte. 9 filter × 16 byte = 144 byte vs 288 byte. Trên STM32F411 (128 KB SRAM) không đáng kể, nhưng **DF2T cũng có numerical stability tốt hơn ở float 32-bit** (ít accumulate error).

### Q3. "PT1 alpha = dT/(RC+dT) — tại sao không phải `1 - exp(-dT/RC)` (chính xác hơn)?"
**A:** Công thức exp là chính xác cho ZOH discretization của RC; công thức tuyến tính là **xấp xỉ Euler forward**, sai số ~(dT/RC)²/2.
- Project: dT=600µs, RC=1/(2π·80)=2ms → dT/RC=0.3 → sai số ~5%.
- Trade-off: `expf()` đắt ~30 cycle, công thức tuyến tính ~5 cycle — 6× nhanh hơn, sai số chấp nhận được.

### Q4. "Filter có **trễ pha** không? Bao nhiêu?"
**A:** Có. LPF 80 Hz Butterworth Q=0.707 ở tần số làm việc 30 Hz: phase shift ≈ −30°. Tại thời điểm 30 Hz, 1 chu kỳ = 33 ms → trễ ~2.7 ms.
- Cộng thêm notch 200 Hz cũng có phase shift ở 30 Hz (gần 0 vì xa cutoff).
- Tổng trễ ~3 ms — chấp nhận được vs PID period 2 ms.

### Q5. "Tại sao acc cutoff 10 Hz mà gyro 80 Hz?"
**A:**
- **Acc** cần rất sạch để AHRS hội tụ đúng hướng trọng lực; tín hiệu chuyển động drone <2 Hz đa số → 10 Hz dư.
- **Gyro** dùng cho rate PID phải bám rất nhanh; cutoff cao giữ band rộng cho phản hồi.

### Q6. "biquadFilterApply chỉ 5 mul — em chắc?"
**A:**
```
y = b0*x + x1                            // 1 mul
x1 = b1*x - a1*y + x2                    // 2 mul
x2 = b2*x - a2*y                         // 2 mul
                          → tổng 5 mul, 3 sub/add
```
Đúng. Plus 1 store/load mỗi state. Total ~10 cycle trên FPU.

### Q7. "Em có check Nyquist không?"
**A:** Có:
```c
if (filterFreq < (1000000 / samplingIntervalUs / 2)) { /* normal init */ }
else { biquadFilterSetupPassthrough(filter); }
```
Nếu cutoff ≥ Nyquist, filter trở thành passthrough (b0=1, các coeff khác = 0). Tránh aliasing và coefficient không hợp lệ.

### Q8. "RMS vibration code line 605–614 dùng `raw_adc_acc_imu` nhưng biến này không update — bug?"
**A:** Em hãy đọc kỹ. Trong `IMU_PROCESS`, `raw_adc_acc_imu` là biến global khởi tạo 0 và **không được update**. `accDiff = raw_adc_acc_imu[i] - accFloorFilt` → thực tế tính `−accFloorFilt`. **Đây là bug có thể** — đáng lẽ phải là `BMI160.acc[i]` thay cho `raw_adc_acc_imu[i]`. Kết quả: accVibe đo "AC component của filter floor" thay vì "AC component của acc". Có thể vẫn ra giá trị có nghĩa (proxy đo rung), nhưng không đúng định nghĩa.

> **Tip vấn đáp:** Tìm được bug và nói thẳng = điểm cao. Đừng giấu.

## Bẫy thường gặp

1. **Filter không reset trước khi ARM** → state cũ → spike đầu tiên → motor giật.
2. **Coefficient tính sai dấu** — chỉ cần đảo dấu `a1` là filter unstable, output divergent.
3. **Áp filter trên dữ liệu chưa scale** (raw int16) → overflow float.
4. **Sample rate không khớp với coefficient** (vd thay đổi GYRO_RATE_US runtime mà không re-init filter) → cutoff trật.
5. **Notch Q quá cao (>10)** → ringing — output dao động khi qua cutoff frequency.

## "Nếu bỏ module này thì sao?"

→ Gyro raw có nhiễu motor 200 Hz đi vào PID → u_roll/u_pitch dao động ±10% → motor giật → drone rung như máy massage → không bay được hoặc rơi do mất control authority.

## Bonus

- Vẽ Bode plot LPF 80 Hz (gain dB vs frequency log).
- Vẽ pole-zero plot biquad LPF — hai pole gần unit circle.
- Phân biệt **Butterworth** (Q=0.707, maximally flat) vs **Bessel** (linear phase) vs **Chebyshev** (ripple).
- **Kalman filter** vs Madgwick: Kalman tối ưu lý thuyết nhưng đòi covariance matrix; Madgwick xấp xỉ gradient descent đơn giản hơn, hiệu năng gần tương đương cho IMU.
- **CMSIS-DSP** có hàm `arm_biquad_cascade_df1_f32` đã optimize SIMD; project tự viết đơn giản hơn.
