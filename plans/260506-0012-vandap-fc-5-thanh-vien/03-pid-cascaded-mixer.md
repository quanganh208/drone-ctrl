# Người C — PID + Cascaded Loop + Motor Mixer (PWM)

## Scope

| | |
|---|---|
| **File** | `Core/Src/PID_Controller.c` (91 LOC), `Core/Src/main.c:479–576` |
| **Hàm chính** | `Pid_Calculate()`, `PidInit()`, `PidReset()`, `MPC()`, `MPC_RATE_MODE()`, `MPC_ANGLE_MODE()`, `Control_Motor()` |
| **Cấu hình PWM** | `tim.c::MX_TIM3_Init`, `MX_TIM4_Init` |
| **Vai trò** | Não điều khiển — biến góc/tốc độ mong muốn → 4 mức PWM motor |

## Phải biết cold

### 1. Vòng lặp cascaded (2 tầng)

```
                   HOVER mode                       RATE mode
       ┌────────────────────────┐         ┌─────────────────────┐
sticks │  → angle_desired       │         │  → angle_rate_desired│
       │       (deg)            │         │       (dps)          │
       └─────────┬──────────────┘         └──────────┬───────────┘
                 ▼                                    │
         ANGLE PID (250 Hz)                           │
         setpoint: angle_desired                      │
         feedback: ARHS.RPY_DEG                       │
         output:   angle_rate_desired (dps)           │
                 ▼                                    │
                 ├────────────────────────────────────┘
                 ▼
         RATE PID (500 Hz)
         setpoint: angle_rate_desired
         feedback: IMU_DATA.w × RAD_TO_DEG
         output:   u_roll, u_pitch, u_yaw
                 ▼
         Motor mixer (Quad-X)
                 ▼
         OneShot125 PWM 4 motor
```

### 2. Vì sao cascade?
- **RATE PID** xử lý nhanh động học góc (gyro responsive ~1 ms).
- **ANGLE PID** chậm hơn vì AHRS update có trễ + acc-gravity convergence.
- Quy tắc: vòng trong **nhanh hơn ít nhất 5×** vòng ngoài → 500 Hz vs 250 Hz đáp ứng quy tắc 2× (project conservative — có thể tăng RATE lên 1000 Hz).

### 3. Cấu trúc PID (PID_Controller.c)

```c
typedef struct {
  pidControllerParam_t param;  // kP, kI, kD, kFF, kT
  float dTermLpfHz;            // LPF tần số cho D-term
  float errorLpfHz;            // LPF tần số cho error (0 = off)
  float integrator;            // bộ tích phân
  float last_input;            // cho derivative-on-measurement
  bool  reset;                 // cờ khởi động lại
  // ... các state lưu kết quả
} pidController_t;
```

### 4. Đặc tính nổi bật của `Pid_Calculate()`

```c
// (a) Derivative on measurement (chống derivative kick)
newDerivative = -(measurement - last_input) / dt;
last_input = measurement;

// (b) Anti-windup back-calculation
const float outVal = P + I + D + FF;
const float outValConstrained = constrainf(outVal, outMin, outMax);
float backCalc = outValConstrained - outVal;
if (SIGN(backCalc) == SIGN(integrator)) backCalc = 0.0f;

// (c) Update integrator
integrator += error*kI*dt + backCalc*kT*dt;
integrator = constrainf(integrator, outMin, outMax);
```

### 5. Công thức kT (back-calc gain)
```
Ti = kP/kI    (integral time)
Td = kD/kP    (derivative time)
kT = 2 / (Ti + Td)    (Åström tuning rule)
```
- Tự tính trong `PidInit` line 73, **đảm bảo back-calc cân bằng với feedback I-term**.

### 6. Tần số PID
| Loop | Period (µs trên TIM2) | Frequency | Lý do |
|---|---|---|---|
| Rate | 2000 | **500 Hz** | Phải nhanh hơn dyn motor (~50 Hz) >>10× |
| Angle | 4000 | **250 Hz** | Đủ cho người dùng, không over-react |
| Pos | 20000 | 50 Hz | (chưa hiện thực) |

Trong code: `if (TIM2->CNT - prev > freq - 100) { run; }` — `−100 µs` để bắt sớm hơn 1 chút, tránh drift.

### 7. Motor mixer Quad-X (main.c:527–530)
```c
m[0] = -u_roll + u_pitch + u_yaw;   // M1 (front-right, CCW)
m[1] = -u_roll - u_pitch - u_yaw;   // M2 (rear-right, CW)
m[2] = +u_roll - u_pitch + u_yaw;   // M3 (rear-left,  CCW)
m[3] = +u_roll + u_pitch - u_yaw;   // M4 (front-left, CW)
```

Lý giải dấu:
- **Roll dương** = nghiêng phải → motor trái (M3,M4) đẩy mạnh hơn → u_roll+ ở trái, u_roll− ở phải. Code: M1,M2 (phải) trừ u_roll; M3,M4 (trái) cộng → đúng.
- **Pitch dương** = chúi mũi xuống → motor đuôi (M2,M3) đẩy mạnh → tương tự.
- **Yaw** dùng phản lực: 2 motor CCW (M1,M3) cộng u_yaw, 2 motor CW (M2,M4) trừ.

### 8. OneShot125 → PWM
```c
pwm[i] = 125 + cmd[i] * 125;        // map cmd[0..1] → pwm[125..250]
TIM4->CCR2 = pwm[0];                // đẩy vào compare register
```
- TIM3/4 prescaler 100−1 → counter clock = 96MHz/100 = **960 kHz** (tick ≈ 1.04 µs).
- Period 500 → ARR = 499 → PWM frequency = 960k/500 = **1.92 kHz**.
- Pulse width 125–250 tick ≈ 130–260 µs (chuẩn OneShot125 spec).

### 9. ARM state machine (main.c::RX_PROCESS line 644)
```c
if (CH[4] > 1500 && CH[2] > MIN_ARM) ARM_Status = ARM;
else                                  ARM_Status = NOT_ARM;
```
- Chỉ ARM khi: AUX1 (CH4) > 1500 **VÀ** throttle > 250 (an toàn).
- Khi NOT_ARM: `cmd[i] = 0` → PWM = 125 → motor stop.

## Code walkthrough — `Pid_Calculate()` đọc to lúc vấn đáp

```c
float Pid_Calculate(pidController_t *pid, float setpoint, float measurement,
                    float dt, float outMin, float outMax)
{
    // (1) tính error, có thể qua LPF
    float error = (errorLpfHz>0)
        ? pt1FilterApply4(&error_filter, setpoint-measurement, errorLpfHz, dt)
        : setpoint - measurement;

    // (2) P-term
    P = error * kP;

    // (3) D-term: derivative ON MEASUREMENT, qua LPF dterm
    if (reset) { last_input = measurement; reset = false; }
    D_raw = -(measurement - last_input) / dt;
    last_input = measurement;
    D = kD * pt1FilterApply4(&dterm_filter, D_raw, dTermLpfHz, dt);

    // (4) FeedForward
    FF = setpoint * kFF;

    // (5) Output + saturate
    outVal           = P + integrator + D + FF;
    outValConstrained = constrainf(outVal, outMin, outMax);

    // (6) Anti-windup back-calculation
    backCalc = outValConstrained - outVal;
    if (SIGN(backCalc) == SIGN(integrator)) backCalc = 0;

    // (7) Update integrator
    integrator += error*kI*dt + backCalc*kT*dt;
    integrator  = constrainf(integrator, outMin, outMax);

    return outValConstrained;
}
```

## Câu hỏi CƠ BẢN

| # | Câu | Hướng trả lời |
|---|---|---|
| 1 | "PID là gì? P, I, D vai trò?" | P = phản ứng tỉ lệ với error; I = tích lũy bù sai số tĩnh; D = đáp ứng nhanh, tắt dao động |
| 2 | "Rời rạc PID viết thế nào?" | `u[k]=Kp·e[k] + Ki·Σe·dt + Kd·(e[k]-e[k-1])/dt` |
| 3 | "Tại sao tách rate và angle?" | Rate đáp ứng nhanh, angle đáp ứng chậm; cascade ổn định và dễ tune |
| 4 | "Cấu hình quad-X nghĩa là gì?" | 4 motor sắp xếp X, mỗi motor đóng góp vào 3 trục |
| 5 | "Vì sao motor xen kẽ CW/CCW?" | Cân bằng phản lực yaw — 2 chiều ngược nhau cộng vector → 0 ở hover |
| 6 | "OneShot125 là gì, khác PWM 50 Hz cũ thế nào?" | Pulse 125–250 µs ở ~2 kHz refresh, latency thấp hơn PWM 1–2 ms ở 50 Hz |
| 7 | "Anti-windup là gì?" | Khi output sat, không cho integrator tiếp tục tăng vô hạn — tránh overshoot dài |
| 8 | "Saturate output ±1000 vì sao?" | Sau đó nhân `pid_rate_scale=1e-3` → `u ∈ [-1, 1]` thuận tiện cho mixer |

## Câu hỏi PHẢN BIỆN

### Q1. "Em dùng D trên measurement chứ không phải D trên error — vì sao?"
**A:** Khi setpoint nhảy bậc (vd stick bay từ 0 → 50°), `d(error)/dt` có spike rất lớn → D-term đẩy ra giá trị cực đoan → motor giật ("derivative kick"). D trên measurement chỉ phản ứng theo thay đổi vật lý, sạch hơn.

### Q2. "Tại sao back-calc check `SIGN(backCalc) == SIGN(integrator)`?"
**A:** Khi output bão hòa âm (outVal < outMin), backCalc dương; nếu integrator đang dương → backCalc kéo integrator xuống = đúng. Nhưng nếu integrator đang âm và backCalc dương cùng dấu sẽ kéo integrator lên xa hơn → SAI. Code check để chỉ áp dụng khi backCalc kéo ngược chiều với integrator (tức kéo về 0).

### Q3. "Tần số PID 500 Hz có đủ không?"
**A:** Đủ cho hầu hết quad nhỏ. Quad racing high-end (Betaflight) chạy 2–8 kHz để xử lý vibration motor cao tần. Với BMI160 ODR 1600 Hz, 500 Hz cho rate là tỉ lệ 1:3 — chấp nhận được. Có thể nâng lên 1000 Hz nếu giảm các blocking call.

### Q4. "Mixer ra cmd > 1.0 hoặc < 0 thì sao?"
**A:** `constrainf(cmd[i], 0.1f, 1.0f)` clamp lại. Tuy nhiên hậu quả là **mất authority** — nếu cần u_roll lớn hơn throttle còn dư, một motor bị clip → mất cân bằng. Giải pháp tốt hơn: **dynamic mix scaling** (giảm throttle để giữ moment) — chưa hiện thực.

### Q5. "Tại sao `cmd >= 0.1` (10% throttle min) chứ không phải 0?"
**A:** ESC cần spin liên tục để giữ phase lock + cảm biến back-EMF ổn định. Dưới 10% có thể stall hoặc desync → có thể không khởi động lại được trong khi bay. **Trade-off:** mất mức 0–10% nhưng an toàn.

### Q6. "Throttle scale `6.101281e-4` từ đâu?"
**A:** Stick CRSF range ~172..1811 (1639 đơn vị tương ứng 0..100%). 1/1639 ≈ 6.101e-4. Sau khi nhân throttle ∈ [0, 1].

### Q7. "Hệ số PID hardcode trong code — có thực tế không?"
**A:** Không. Project có hàm `tune_pid()` (main.c:685) cho phép chỉnh kP/kI/kD bằng các channel CH[6..9] ngay trên radio (auxiliary switches). Kết quả tune lưu RAM, **mất khi reset** — tech debt: cần lưu Flash hoặc EEPROM.

### Q8. "kT = 2/(Ti+Td) — em chứng minh được không?"
**A:** Åström: nếu loop có closed-loop time constant ≈ Tt (tracking time), back-calc với gain `1/Tt` sẽ ổn định. Heuristic Tt ≈ √(Ti·Td) hoặc trung bình. Công thức `2/(Ti+Td)` là **xấp xỉ đơn giản trung bình** dễ tính, đủ cho hầu hết hệ thống không quá khắt khe.

### Q9. "Vì sao yaw dùng kI cao (0.638) còn roll/pitch kI = 2.22?"
**A:** Yaw có quán tính lớn hơn 2 trục còn lại (drone vòng tròn tròn hơn dài), nên cần kP cao mà kI thấp để tránh overshoot. Roll/pitch quán tính nhỏ → cần I-term mạnh để bù gió + bias.

## Bẫy thường gặp

1. **Quên reset PID khi đổi mode** → integrator giữ giá trị cũ → motor bùng phát. Code `RESET_RATE_PID()` được gọi ở line 656, 669.
2. **dt = 0** lỡ tính 1/dt → divide by zero. Check `freq - 100 > 0` đảm bảo dt ≥ ~1.9 ms.
3. **Mixer chia float** → chậm. Project tránh, dùng cộng/trừ.
4. **Motor calibration thiếu** → ESC không recognize range 125–250 → motor không quay. Cần script calibration: ARM với throttle max → ARM với throttle min.
5. **PWM polarity sai** → motor quay ngược; sửa bằng đổi 2 dây trong 3 dây ESC hoặc đổi config.

## "Nếu bỏ module này thì sao?"

→ Drone không phản ứng với gyro/angle → không tự cân bằng → rơi ngay khi rời tay.

## Bonus

- Tune PID 3 bước Ziegler-Nichols: tăng kP đến oscillation, đo Tu, áp công thức.
- Khác biệt **Integral Anti-Windup**: clamping vs back-calc vs conditional integration. Project dùng back-calc.
- **Setpoint weighting** (Åström): thêm hệ số b, c < 1 để giảm reaction P/D với setpoint change. Project chưa có.
- **PID parallel form** vs **standard form** — code đang dùng parallel (kP, kI, kD độc lập).
- **Feedforward** kFF = 0 trong project, nhưng cấu trúc đã có. FF giúp tracking khi setpoint thay đổi nhanh.
