/**
 * SportAPI Service — ĐÃ CHUYỂN ĐỔI HOÀN TOÀN SANG SOFASCORE DIRECT API.
 *
 * Gỡ bỏ 100% RapidAPI headers và quota 50 req/tháng.
 * Toàn bộ xử lý hiện được ủy quyền trực tiếp tới SofaScore service (server/services/sofascore.ts).
 */

export * from './sofascore.js'
