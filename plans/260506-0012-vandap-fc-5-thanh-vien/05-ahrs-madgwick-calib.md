# Người E — AHRS Madgwick + IMU Calibration 6-face

## Scope

| | |
|---|---|
| **File** | `Core/Src/ARHS.c` (425 LOC), `Core/Src/IMU_CALIBRATE.c` (539 LOC) |
| **Hàm chính** | `ARHS_Predict()`, `ARHS_Update()`, `Norm_Q()`, `EQ_ZYX()`, `QE_ZYX()`, `IMU_PROCESS_CALIBRATE()`, `IMU_CalcSimpleCalibrate()`, `IMU_CalcCrossAxisFrom6Face()`, `IMU_ApplySimpleCalibrate()` |
| **Vai trò** | Sensor fusion — biến gyro+acc thành góc roll/pitch/yaw chính xác |

## Phải biết cold

### 1. Tại sao cần AHRS?
- **Gyro** chính xác instantaneously nhưng integrate sẽ **drift** (bias tăng theo thời gian).
- **Acc** đo trọng lực → chỉ đúng tĩnh; khi drone tăng tốc → đo cả gia tốc tuyến tính (không phải chỉ g).
- **Magnetometer** đúng heading nhưng nhạy với từ trường nhiễu.
→ **AHRS** = cảm biến fusion: gyro cho dynamics, acc/mag correct drift.

### 2. Quaternion là gì?
- Số 4 chiều `q = q0 + q1·i + q2·j + q3·k` biểu diễn rotation 3D.
- `|q| = 1` (unit quaternion).
- Lợi:
  - Không gimbal-lock (vấn đề kinh điển của Euler khi pitch=±90°).
  - Tích phân ổn định: `q̇ = 0.5·q ⊗ ω`.
  - Nhân quaternion = composition rotation, rẻ hơn ma trận 3×3 (4 mul vs 27 mul).

### 3. Madgwick filter — ý tưởng

```
                           ω (gyro)
                              │
                              ▼
                    qDot_gyro = 0.5·q ⊗ ω  ──┐
                                              ├──► qDot − β·∇F → integrate → q
   acc/mag ───► gradient ∇F của cost ────────┘
                                  
   F(q,a,m) = "rotation by q của trọng lực/từ trường − measurement"
   β (B_madgwick) = "tốc độ correct"
```

- **Predict-only (`ARHS_Predict`)**: 6-DOF (gyro+acc), không có mag → yaw drift.
- **Predict+Update (`ARHS_Update`)**: 9-DOF (gyro+acc+mag) → yaw cố định.

### 4. Bootstrap β

```c
if (predict_count < 4000)  B_madgwick = B_default × 100;  // học nhanh ban đầu
else                        B_madgwick = B_default;        // β = 0.012 ổn định
```
- 4000 sample × 600 µs = 2.4 s đầu drone đứng yên → AHRS hội tụ về góc thật.
- Sau đó giảm β để gyro chiếm ưu thế (đỡ noise acc).

### 5. Quaternion → Euler ZYX (`QE_ZYX` ARHS.c:36)
```
yaw   = atan2(2(q1·q2 + q0·q3),  q0² + q1² − q2² − q3²)
pitch = asin(−2(q1·q3 − q0·q2))
roll  = atan2(2(q2·q3 + q0·q1),  q0² − q1² − q2² + q3²)
```
- ZYX: rotate quanh Z trước (yaw), Y (pitch), X (roll).
- `asin` có domain [−1,1] — gimbal-lock ở pitch ±90° (nhưng quaternion vẫn đúng).

### 6. Rotation matrix R(q) (ARHS.c:257–265)
Dùng để chuyển acc body-frame ↔ world-frame:
```
R = [ q0²+q1²−q2²−q3²    2(q1q2−q0q3)    2(q1q3+q0q2) ]
    [ 2(q1q2+q0q3)    q0²−q1²+q2²−q3²    2(q2q3−q0q1) ]
    [ 2(q1q3−q0q2)    2(q2q3+q0q1)    q0²−q1²−q2²+q3² ]
```
- Project tính `acc_linear_fixer_frame = −R·acc_body − [0,0,−g]` để được gia tốc thực (đã bỏ trọng lực, chuyển về world).
- Tích phân được vận tốc world: `vel = vel + acc·dt`.

### 7. IMU Calibration

#### 7a. Simple 6-face (acc):
```
Đặt 6 mặt: X+, X−, Y+, Y−, Z+, Z−. Mỗi mặt đo 4000 sample.

bias[i]  = (acc_positive[i] + acc_negative[i]) / 2     // offset
scale[i] = 2g / (acc_positive[i] − acc_negative[i])     // gain

Áp dụng:  out[i] = (raw[i] − bias[i]) × scale[i]
```

#### 7b. Cross-axis (M ma trận 3×3 + bias):
- 6 mặt × 3 kênh = 18 phương trình.
- Unknowns: 9 phần tử M + 3 bias = 12 ẩn.
- **Gauss-Newton iteration** (max 20 vòng):
  ```
  h(x) = M·a_ref + b
  p    = h − measurement
  J    = ∂h/∂x  (Jacobian 18×12, hằng số khi a_ref tĩnh)
  dx   = −(JᵀJ)⁻¹·Jᵀ·p
  x   ← x + dx
  ```
- Tốt hơn simple vì correct được lệch trục (acc X bị mix vào Y).

#### 7c. Gyro bias:
- Đặt drone đứng yên 5000 sample → trung bình → `offset_gyro[3]`.
- Áp dụng: `gyro_calibrated = gyro_raw − offset_gyro`.

### 8. CMSIS-DSP usage

Project dùng nhiều hàm ARM:
```c
arm_sqrt_f32       // sqrt nhanh dùng instruction VSQRT.F32
arm_mat_init_f32   // wrap data + dimensions vào struct
arm_mat_mult_f32   // ma trận C = A × B
arm_mat_inverse_f32// nghịch đảo (Gauss-Jordan)
arm_mat_trans_f32  // chuyển vị
arm_mat_add_f32, arm_mat_sub_f32
arm_dot_prod_f32, arm_scale_f32, arm_copy_f32
```
- Optimize SIMD instructions (Cortex-M4 hỗ trợ SMLAD, SADD16…).

## Code walkthrough — `ARHS_Predict()` rút gọn

```c
void ARHS_Predict(arhs, imu){
    // (1) Bootstrap β
    B = (predict_count < 4000) ? B_default*100 : B_default;

    // (2) qDot từ gyro: q̇ = 0.5·q⊗ω
    qDot1 = 0.5*(-q1*gx - q2*gy - q3*gz);
    qDot2 = 0.5*( q0*gx + q2*gz - q3*gy);
    qDot3 = 0.5*( q0*gy - q1*gz + q3*gx);
    qDot4 = 0.5*( q0*gz + q1*gy - q2*gx);

    // (3) Nếu acc khác 0 → tính gradient F(q,a) và sửa qDot
    if (acc != 0) {
        normalize(acc);
        // gradient của (R(q)·g − a) bình phương
        s0..s3 = ... (công thức Madgwick simplified)
        normalize(s);
        qDot −= β·s;
    }

    // (4) Integrate
    q += qDot · dt;
    normalize(q);

    // (5) Convert sang Euler để PID dùng
    QE_ZYX(q, RPY_RAD);
    RPY_DEG = RPY_RAD * 180/π;

    // (6) Compute rotation matrix → linear acc world-frame
    R = quaternion_to_matrix(q);
    acc_linear_world = R·(−acc_body) − [0,0,−g];
}
```

## Câu hỏi CƠ BẢN

| # | Câu | Hướng trả lời |
|---|---|---|
| 1 | "AHRS là gì? Khác IMU thế nào?" | IMU = sensor thô; AHRS = thuật toán fusion → góc tư thế |
| 2 | "Tại sao quaternion?" | Tránh gimbal-lock, integrate ổn định, nhân rẻ |
| 3 | "Madgwick vs Mahony vs Kalman?" | Madgwick gradient descent đơn giản; Mahony complementary; Kalman optimal nhưng đắt |
| 4 | "Β cao thấp ý nghĩa gì?" | Cao = tin acc nhiều, hội tụ nhanh nhưng noise; Thấp = tin gyro, mượt nhưng drift |
| 5 | "Vì sao cần normalize quaternion?" | Tích phân số tích lũy lỗi → q lệch khỏi unit sphere → R(q) sai |
| 6 | "Gimbal lock là gì?" | Khi pitch ±90°, roll và yaw quay về cùng 1 trục — mất 1 bậc tự do trong Euler |
| 7 | "Calibrate IMU 6 mặt làm gì?" | Tính bias offset + scale factor cho mỗi trục acc |
| 8 | "Gyro bias từ đâu?" | Sai số nhà máy + nhiệt độ + ageing — phải đo lại mỗi lần khởi động |

## Câu hỏi PHẢN BIỆN

### Q1. "Madgwick có gì hơn Kalman?"
**A:** Tradeoff:
- **Kalman EKF**: optimal nếu biết covariance Q,R chính xác; cần linearize (Jacobian); chi phí cao (~100 mul/iteration cho 4-state quaternion).
- **Madgwick**: chỉ 1 tham số tune (β); ~30 mul/iteration; gần optimal trên thực tế (Madgwick paper 2010 chứng minh).
- Project chọn Madgwick = đơn giản, đủ chính xác cho quad nhỏ.

### Q2. "Β = 0.012 — em đo từ đâu?"
**A:** Empirical từ paper Madgwick: `β = √(3/4)·gyro_drift_max`. Với BMI160, gyro_drift max ~0.01 rad/s → β ~0.0086. Project chọn 0.012 conservative hơn → fast correction nhưng noisy hơn 1 chút. **Có thể tune nếu thấy chao**.

### Q3. "Predict không có mag → yaw drift bao nhiêu?"
**A:** Gyro drift ~0.5°/s (quy mô BMI160 bias). Trong vòng 1 phút → 30°. Trong project, `MPC_Status = HOVER` chỉ giữ heading **tại thời điểm enable**:
```c
angle_desired[2] = ARHS.RPY_DEG[2];  // line 671 — capture lúc switch mode
```
Sau đó PID YAW giữ heading đó. Drift gyro vẫn xảy ra trên RPY[2] nội bộ → desired bám theo drift → không rõ ràng cho user. **Cần mag để fix dài hạn.**

### Q4. "Tại sao bootstrap β × 100 ở 4000 sample đầu?"
**A:** Khi power-on, q khởi tạo `[1,0,0,0]` (no rotation). Drone thực có thể nghiêng — cần hội tụ về góc đúng. β cao = gradient mạnh = converge ~2 s. Sau đó giảm để giữ noise thấp. Đây là **technique kinh điển** của Madgwick implementation thực tế.

### Q5. "Khi drone tăng tốc, acc đo cả gia tốc tuyến tính + g — AHRS sai chứ?"
**A:** Đúng — giả định Madgwick là "acc ≈ g". Khi tăng tốc mạnh (vd 0.5 g), AHRS sẽ đọc nhầm direction trọng lực → roll/pitch bias. Cách handle:
- Reduce β khi `|acc| ≠ 1g` (project chưa làm).
- Dùng GPS velocity để compensate (chưa có).
- Chấp nhận sai số 1-2° tạm thời — drone tự về đúng khi hover lại.

### Q6. "Tại sao normalize quaternion `q/|q|` chứ không clamp?"
**A:** Quaternion đại diện rotation phải nằm trên 3-sphere `|q|=1`. Nếu chỉ clamp một thành phần, tỷ lệ giữa 4 components sai → rotation trở thành scaling/skew → R(q) không còn orthogonal → tính linear acc bị méo.

### Q7. "Gauss-Newton trong calibration cross-axis có chắc hội tụ?"
**A:** Không **chắc** với mọi initial guess. Project khởi tạo `M = I` (identity) → đã gần đúng → hội tụ trong vài iteration. Nếu calibration điều kiện kém (thiếu mặt, sample noisy), có thể không hội tụ → code có fallback:
```c
if (status != ARM_MATH_SUCCESS) {  // arm_mat_inverse fail
    M = identity;
    b = 0;
    return;
}
```

### Q8. "Tại sao `EQ_ZYX` rồi `QE_ZYX` ngay sau (line 105–106)?"
**A:** Vòng `Complimentary_Filter_Predict` tính Euler trực tiếp từ angular rates → cần đẩy lên quaternion để dùng làm reference, sau đó decompose lại Euler để chuẩn hoá quy ước. **Hơi tốn cycle nhưng đảm bảo singularity-free.** Trong `ARHS_Predict` (filter chính), không có round-trip này — efficient hơn.

### Q9. "Em hiểu công thức gradient F không?"
**A:** Cost function:
```
F(q, a) = R(q)·[0,0,1]ᵀ − a_norm
```
Với R quaternion-rotation matrix. Gradient `∇F` được derive analyticly từ paper Madgwick. Code dùng dạng đã tối ưu (s0..s3 trong line 209–212). Em chưa từ derive lại từ đầu, nhưng **hiểu đầu vào (q, a) → đầu ra là 4D vector hướng giảm cost**.

> *(Đây là câu khó — thừa nhận giới hạn là tốt hơn bịa.)*

## Bẫy thường gặp

1. **Initial q = [0,0,0,0]** thay vì `[1,0,0,0]` → norm = 0 → divide zero → NaN lan ra cả hệ thống.
2. **Sign convention** acc đảo dấu `ax = -imu_data->acc[0]` (line 175) — nếu quên đảo, AHRS converge ngược 180°.
3. **dt sai đơn vị** (s vs ms) → tốc độ hội tụ sai 1000×.
4. **Mag chưa calibrate** vào `ARHS_Update` → yaw chao → tốt nhất không dùng nếu chưa calib hard/soft iron.
5. **Calibration acc trong khi rung** → trung bình vẫn lệch → S, bias sai.

## "Nếu bỏ module này thì sao?"

→ Không có RPY → ANGLE PID không có feedback → HOVER mode không hoạt động → chỉ còn RATE mode (tốc độ thuần) — drone bay được nhưng người chưa quen sẽ không stabilize → rơi.

## Bonus

- Vẽ "tangent-vector" gradient descent trên 3-sphere quaternion.
- Khác biệt **NED** (North-East-Down — máy bay) vs **ENU** (East-North-Up — robotic) vs **NWU** (project, line 384–387 commented).
- **Mahony filter**: complementary `q_new = q_gyro + Ki·∫err + Kp·err` — tương đương Madgwick trong nhiều trường hợp.
- **Hard iron** vs **Soft iron** calibration cho mag — project chỉ normalize, chưa correct ellipsoid.
- **Allan variance** cho gyro/acc spec — đo ARW (Angle Random Walk), bias instability.
- **Quaternion vs Direction Cosine Matrix (DCM)**: DCM ổn định numerically nhưng 9 floats; quaternion 4 floats — project chọn quaternion.
