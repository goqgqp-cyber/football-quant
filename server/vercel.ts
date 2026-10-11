/**
 * Entry cho function Vercel.
 *
 * Được esbuild bundle (xem `scripts/build-api.mjs`) thành `api/[[...route]].js`
 * — MỘT file JS self-contained, không còn import tương đối kiểu NodeNext
 * (`./app.js` trỏ tới `app.ts`). Đây là lý do trước đây function crash lúc
 * khởi tạo trên Vercel → client chỉ thấy "Lỗi 500" trống.
 *
 * `dotenv.js` chỉ đọc `.env` khi file tồn tại (môi trường dev). Trên Vercel
 * biến môi trường do platform bơm trực tiếp nên loader là no-op.
 */
import './dotenv.js'
import { handle } from 'hono/vercel'
import { app } from './app.js'

export default handle(app)
