# แผนการตรวจนับสต็อก (Stock Count Plan)

เว็บสำหรับวางแผนและติดตามการตรวจนับสต็อก (Cycle count) แยกตามโซน A–L, R, S, M, P และ Spare part
นำเข้าผลนับจาก SAP **MI24** (.xlsx) ได้โดยตรง

## หน้าในระบบ
| หน้า | ใช้ทำอะไร |
|---|---|
| ภาพรวมโซน | สถานะของแต่ละ Sloc ในรอบที่เลือก (นับครบ / ไม่ครบ / มีแผน / เลยกำหนด) และ % ต่อโซน |
| ติดตามรายไตรมาส | วงแหวน % ของไตรมาส, แถบ % ต่อโซน, Heatmap โซน × Q1–Q4, ตาราง Sloc × ไตรมาส |
| แผน & ปฏิทิน | ปฏิทินแผนเทียบกับวันที่นับจริง, เพิ่ม/แก้แผน, จัดแผนอัตโนมัติ |
| ประวัติการนับ | สรุปต่อเอกสาร PI × Sloc, กรองรายการที่มีผลต่าง/นับไม่ครบ, บันทึกผลนับเอง |
| นำเข้า MI24 / ตั้งค่า | ลากไฟล์ MI24 มาวาง, รอบการนับ, เดือนเริ่มปี, รายชื่อ Sloc และโซน |

## การจัดโซนอัตโนมัติ (แก้ได้ในหน้าตั้งค่า)
- `E` + ตัวอักษร A–L → Zone A–L (เช่น EAC0 → A, EKA3 → K)
- `EWR*` → Zone R, `SWR*` → Zone S, `MWR*` → Zone M, `PWR*` → Zone P
- `EWS*` → Spare part

## เก็บข้อมูลที่ไหน
- ตั้ง `DATABASE_URL` (PostgreSQL เช่น Neon) → เก็บในตาราง `stockcount_docs` ข้อมูลไม่หายเมื่อรีสตาร์ต
- ไม่ตั้ง → เก็บเป็นไฟล์ `data/stockcount.json` (ใช้ในเครื่อง/ทดสอบ)
- ไฟล์ Excel ถูกอ่านในเบราว์เซอร์ ไม่ได้อัปโหลดทั้งไฟล์ เก็บเฉพาะสรุปต่อเอกสาร PI × Sloc
- ข้อมูลการนับ **ไม่ได้อยู่ใน GitHub** (อยู่ในฐานข้อมูลเท่านั้น)

## Environment variables
| ชื่อ | ค่า |
|---|---|
| `DATABASE_URL` | Connection string ของ Neon (`postgresql://...`) — ใช้ฐานข้อมูลเดียวกับ label-scan2 ได้ ตารางไม่ชนกัน |
| `EDIT_PIN` | (ไม่บังคับ) PIN สำหรับแก้ไข/นำเข้า ถ้าไม่ตั้ง ทุกคนที่เปิดลิงก์แก้ไขได้ |

## Deploy บน Render
1. Render → **New → Web Service** → เลือก repo นี้
2. Runtime: **Node** · Build command: `npm install` · Start command: `node server.cjs` · Instance type: **Free**
3. Environment → เพิ่ม `DATABASE_URL` (และ `EDIT_PIN` ถ้าต้องการ)
4. กด Deploy → ใน Log ต้องเห็น `Storage: PostgreSQL (DATABASE_URL) ✓`
5. เปิดลิงก์ → แท็บ **นำเข้า MI24** → ลากไฟล์ MI24 มาวาง → นำเข้า

ตรวจสถานะ: `https://<ชื่อบริการ>.onrender.com/health`

## รันในเครื่อง
```
npm install
node server.cjs        # เปิด http://localhost:3010
```
