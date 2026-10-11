/**
 * Store in-memory dự phòng cho DEV khi CHƯA cấu hình Upstash.
 *
 * Mô phỏng đúng các lệnh REST mà app đang dùng (get/set/del/lpush/lrange/lrem/
 * sadd/srem/smembers/expire/ping) để `server/redis.ts` có thể thay thế client
 * thật mà không phải sửa `store.ts` / `auth.ts`.
 *
 * ⚠️ Dữ liệu mất khi restart tiến trình và KHÔNG dùng được cho production.
 * Chỉ hoạt động khi thiếu `UPSTASH_REDIS_REST_URL` hoặc `UPSTASH_REDIS_REST_TOKEN`.
 */

interface Entry {
    value: unknown
    expireAt?: number
}

export class MemoryRedis {
    private store = new Map<string, Entry>()
    private lists = new Map<string, string[]>()
    private sets = new Map<string, Set<string>>()

    private alive(key: string): boolean {
        const e = this.store.get(key)
        if (!e) return false
        if (e.expireAt !== undefined && e.expireAt <= Date.now()) {
            this.store.delete(key)
            return false
        }
        return true
    }

    async ping(): Promise<string> {
        return 'PONG'
    }

    async get<T = unknown>(key: string): Promise<T | null> {
        if (!this.alive(key)) return null
        const v = this.store.get(key)?.value
        return (v ?? null) as T | null
    }

    async set(key: string, value: unknown, opts?: { ex?: number }): Promise<'OK'> {
        const expireAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined
        this.store.set(key, { value, expireAt })
        return 'OK'
    }

    async del(...keys: string[]): Promise<number> {
        let n = 0
        for (const k of keys) {
            const a = this.store.delete(k)
            const b = this.lists.delete(k)
            const c = this.sets.delete(k)
            if (a || b || c) n++
        }
        return n
    }

    async lpush(key: string, ...values: string[]): Promise<number> {
        const list = this.lists.get(key) ?? []
        for (const v of values) list.unshift(v)
        this.lists.set(key, list)
        return list.length
    }

    async lrange<T = string>(key: string, start: number, stop: number): Promise<T[]> {
        const list = this.lists.get(key) ?? []
        const end = stop < 0 ? list.length + stop + 1 : stop + 1
        return list.slice(start, end) as T[]
    }

    async lrem(key: string, count: number, value: string): Promise<number> {
        const list = this.lists.get(key)
        if (!list) return 0
        let removed = 0
        if (count === 0) {
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i] === value) {
                    list.splice(i, 1)
                    removed++
                }
            }
        } else if (count > 0) {
            for (let i = 0; i < list.length && removed < count;) {
                if (list[i] === value) {
                    list.splice(i, 1)
                    removed++
                } else {
                    i++
                }
            }
        } else {
            const limit = -count
            for (let i = list.length - 1; i >= 0 && removed < limit; i--) {
                if (list[i] === value) {
                    list.splice(i, 1)
                    removed++
                }
            }
        }
        return removed
    }

    async sadd(key: string, ...members: string[]): Promise<number> {
        const set = this.sets.get(key) ?? new Set<string>()
        let added = 0
        for (const m of members) {
            if (!set.has(m)) {
                set.add(m)
                added++
            }
        }
        this.sets.set(key, set)
        return added
    }

    async srem(key: string, ...members: string[]): Promise<number> {
        const set = this.sets.get(key)
        if (!set) return 0
        let removed = 0
        for (const m of members) if (set.delete(m)) removed++
        return removed
    }

    async smembers<T = string[]>(key: string): Promise<T> {
        return Array.from(this.sets.get(key) ?? []) as unknown as T
    }

    async expire(key: string, seconds: number): Promise<number> {
        const e = this.store.get(key)
        if (!e) return 0
        e.expireAt = Date.now() + seconds * 1000
        return 1
    }
}
