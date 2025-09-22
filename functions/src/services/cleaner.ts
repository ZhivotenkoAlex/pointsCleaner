import { db } from "../index"
import { Timestamp } from "firebase-admin/firestore"

type PersonalHistory = {
  id: string
  delta?: number
  user_id?: string
  date?: FirebaseFirestore.Timestamp | Date
  company_id?: string
  points_type_id?: string
  money?: number
  [key: string]: unknown
}

const DAY_MS = 24 * 60 * 60 * 1000
const getMillis = (d?: FirebaseFirestore.Timestamp | Date): number => {
  if (!d) return Number.NaN
  const anyD = d as any
  if (typeof anyD?.toMillis === "function") return anyD.toMillis()
  return (d as Date).getTime()
}

const computeExpiredUnspentFIFO = (
  history: PersonalHistory[],
  lifetimeDays: number
): Record<string, number> => {
  const nowMs = Date.now()
  const queues: Record<string, { amount: number; expiresAtMs: number }[]> = {}

  const ordered = [...history].sort(
    (a, b) => getMillis(a.date) - getMillis(b.date)
  )

  for (const row of ordered) {
    const pt = (row.points_type_id as string) || "0"
    const typeId = pt === "" ? "0" : pt
    const delta = Number(row.delta ?? 0)
    if (!Number.isFinite(delta) || delta === 0) continue

    if (!queues[typeId]) queues[typeId] = []

    if (delta > 0) {
      const createdMs = getMillis(row.date)
      const expiresAtMs = createdMs + lifetimeDays * DAY_MS
      queues[typeId].push({ amount: delta, expiresAtMs })
    } else {
      let spend = -delta
      const q = queues[typeId]
      while (spend > 0 && q?.length > 0) {
        const head = q[0]
        const take = Math.min(head.amount, spend)
        head.amount -= take
        spend -= take
        if (head.amount <= 0) q.shift()
      }
    }
  }

  const result: Record<string, number> = {}
  for (const [typeId, q] of Object.entries(queues)) {
    let sum = 0
    for (const b of q) if (b.expiresAtMs <= nowMs) sum += b.amount
    if (sum > 0) result[typeId] = sum
  }
  return result
}
const parseLifetimeDays = (term: unknown): number => {
  if (typeof term === "number" && Number.isFinite(term)) return term
  if (typeof term === "string") {
    const t = term.trim().toLowerCase()
    const m = t.match(
      /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)?$/
    )
    if (m) {
      const n = Number(m[1])
      const u = (m[2] || "days")[0]
      if (u === "d") return n
      if (u === "w") return n * 7
      if (u === "m") return n * 30 // if you need calendar months, handle differently
      if (u === "y") return n * 365
    }
    if (t === "day" || t === "d") return 1
    if (t === "week" || t === "w") return 7
    if (t === "month" || t === "m") return 30
    if (t === "year" || t === "y") return 365
  }
  throw new Error(`Invalid points_lifetime_term: ${String(term)}`)
}

/**
 * Retrieves a bill.
 * @param {string} billId The bill id.
 * @return {Promise<any>} The bill object or null if not found.
 */
export async function start() {
  console.log(" starting cleaner")

  try {
    const configQuery = await db
      .collection("points_cleaner_config")
      .where("is_active", "==", true)
      .get()
    const configs = configQuery.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>
      return {
        id: doc.id,
        is_active: data?.is_active as boolean,
        company: (data?.company_id as string) ?? "",
        lifetimeDays: parseLifetimeDays(data?.points_lifetime_term as unknown),
      }
    })

    const results: Array<{
      company: string
      cutoff: Date
      usersProcessed: number
    }> = []

    for (const { company, lifetimeDays } of configs) {
      const cutoff = new Date(Date.now() - lifetimeDays * DAY_MS)

      // Firestore: allow only one inequality field per query.
      // We'll do inequality on `date` and filter `delta > 0` in-memory.
      const historySnapshot = await db
        .collection("personal-number-history")
        .where("company_id", "==", company)
        .where("date", "<", cutoff)
        .get()

      if (historySnapshot.empty) {
        continue
      }

      const expiredPointsItems: PersonalHistory[] = historySnapshot.docs.map(
        (doc) => ({
          id: doc.id,
          ...(doc.data() as Record<string, unknown>),
        })
      )

      const positiveExpired = expiredPointsItems.filter(
        (p) => typeof p.delta === "number" && p.delta > 0
      )

      // Aggregate per user and by points_type_id
      type TotalsByType = Record<string, number>
      const userTotals = new Map<string, TotalsByType>()

      for (const item of positiveExpired) {
        const uid = item.user_id
        if (!uid) continue
        const pt = (item.points_type_id as string) || "0"
        const typeId = pt === "" ? "0" : pt
        const delta = Number(item.delta ?? 0)
        if (!Number.isFinite(delta) || delta <= 0) continue

        const types = userTotals.get(uid) ?? {}
        types[typeId] = (types[typeId] ?? 0) + delta
        userTotals.set(uid, types)
      }

      // Emit logs per user and keep map for later simple diff
      const summaries = Array.from(userTotals.entries()).map(
        ([uid, totals]) => {
          const total = Object.values(totals).reduce((s, n) => s + n, 0)
          return { user_id: uid, totalsByType: totals, total }
        }
      )

      // users we need to consider based on any expired accruals
      const userIds = summaries.map((s) => s.user_id)
      for (const uid of userIds) {
        // Find or create fan doc by user_id
        const fanSnap = await db
          .collection("fans")
          .where("user_id", "==", uid)
          .limit(1)
          .get()

        const fanData = fanSnap.docs[0]?.data?.() ?? {}

        // Fetch full user history for FIFO calculation
        // Query by user_id only (filter company in-memory) to avoid composite index need
        const fullHistSnap = await db
          .collection("personal-number-history")
          .where("user_id", "==", uid)
          .get()
        const fullHistory: PersonalHistory[] = fullHistSnap.docs
          .map((d) => ({
            id: d.id,
            ...(d.data() as Record<string, unknown>),
          }))
          .filter((row) => String((row as any).company_id) === String(company))

        const expireDiffByType = computeExpiredUnspentFIFO(
          fullHistory,
          lifetimeDays
        )

        const fanUpdates: Record<string, number> = {}
        for (const [typeId, diff] of Object.entries(expireDiffByType) as [
          string,
          number,
        ][]) {
          const key = !typeId || typeId === "0" ? "money" : `points_${typeId}`
          const currentVal = Number((fanData as any)[key] ?? 0)
          fanUpdates[key] = currentVal - diff
        }

        // for (const [typeId, diff] of Object.entries(expireDiffByType)) {
        //   const key = !typeId || typeId === "0" ? "money" : `points_${typeId}`
        //   const historyData: Record<string, unknown> = {
        //     user_id: uid,
        //     company_id: company,
        //     points_type_id: typeId,
        //     delta: -diff,
        //     type: "SYSTEM",
        //     reason: "expired",
        //     date: Timestamp.now(),
        //     foreign_id: "",
        //     product_id: "",
        //     gamification_id: "",
        //     partner_company_id: "",
        //     personal_number: null,
        //   }
        //   historyData[key] = fanUpdates[key]
        // }

        // Also compute DIFF directly from expired items (handle ALL expired items)
        const expiredByType = userTotals.get(uid) ?? {}
        const expiredFanUpdates: Record<string, number> = {}
        for (const [typeId, diff] of Object.entries(expiredByType)) {
          const key = !typeId || typeId === "0" ? "money" : `points_${typeId}`
          const currentVal = Number((fanData as any)[key] ?? 0)
          expiredFanUpdates[key] = currentVal - diff
        }

        const spentByType: Record<string, number> = {}
        for (const row of fullHistory) {
          const pt = (row.points_type_id as string) || "0"
          const typeId = pt === "" ? "0" : pt
          const delta = Number(row.delta ?? 0)
          if (!Number.isFinite(delta) || delta >= 0) continue
          spentByType[typeId] = (spentByType[typeId] ?? 0) + Math.abs(delta)
        }

        const simpleDiffByType: Record<string, number> = {}
        const keys = new Set<string>([
          ...Object.keys(expiredByType),
          ...Object.keys(spentByType),
        ])
        for (const k of keys) {
          const diff = Math.max(
            0,
            (expiredByType[k] ?? 0) - (spentByType[k] ?? 0)
          )
          if (diff > 0) simpleDiffByType[k] = diff
        }

        const simpleFanUpdates: Record<string, number> = {}
        for (const [typeId, diff] of Object.entries(simpleDiffByType)) {
          const key = !typeId || typeId === "0" ? "money" : `points_${typeId}`
          const currentVal = Number((fanData as any)[key] ?? 0)
          simpleFanUpdates[key] = currentVal - diff
        }

        // Purchases: find items with negative money (spent) before cutoff, per user/type
        const purchasesSnap = await db
          .collection("personal-number-history")
          .where("company_id", "==", company)
          .where("user_id", "==", uid)
          .get()
        const negativePurchases: PersonalHistory[] = purchasesSnap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
          .filter(
            (row) =>
              typeof (row as any).delta === "number" && (row as any).delta < 0
          )

        const spentByTypeFromMoney: Record<string, number> = {}
        for (const row of negativePurchases) {
          const pt = (row.points_type_id as string) || "0"
          const typeId = pt === "" ? "0" : pt
          const spent = Math.abs(Number(row.delta ?? 0))
          if (!Number.isFinite(spent) || spent <= 0) continue
          spentByTypeFromMoney[typeId] =
            (spentByTypeFromMoney[typeId] ?? 0) + spent
        }

        // Net per-type: spent - expired. Only create history if negative
        const netFromPurchases: Record<string, number> = {}
        const allTypes = new Set<string>([
          ...Object.keys(expiredByType),
          ...Object.keys(spentByTypeFromMoney),
        ])
        for (const k of allTypes) {
          const spent = spentByTypeFromMoney[k] ?? 0
          const expired = expiredByType[k] ?? 0
          const diff = spent - expired
          if (diff < 0) netFromPurchases[k] = diff // negative => need to create history
        }

        if (Object.keys(netFromPurchases).length > 0) {
          const fanUpdatesFromNet: Record<string, number> = {}
          for (const [typeId, diff] of Object.entries(netFromPurchases)) {
            const key = !typeId || typeId === "0" ? "money" : `points_${typeId}`
            const currentVal = Number(fanData[key] ?? 0)
            fanUpdatesFromNet[key] = currentVal + diff // diff is negative
          }

          if (uid === "yTv3qreQesa0SyAHtY5D") {
            const fanDoc = fanSnap.docs[0]
            await fanDoc.ref.update(fanUpdatesFromNet)

            for (const [typeId, diff] of Object.entries(netFromPurchases)) {
              const key =
                !typeId || typeId === "0" ? "money" : `points_${typeId}`
              const historyData: Record<string, unknown> = {
                admin_id: null,
                user_id: uid,
                money: fanUpdatesFromNet[key],
                company_id: company,
                points_type_id: typeId,
                delta: diff,
                type: "SYSTEM",
                reason: "expired points",
                date: Timestamp.now(),
                foreign_id: "",
                product_id: "",
                gamification_id: "",
                partner_company_id: "",
                personal_number: null,
              }

              const historyRef = db.collection("personal-number-history").doc()
              await historyRef.set({ id: historyRef.id, ...historyData })
            }
          }
        }
      }

      results.push({ company, cutoff, usersProcessed: userIds.length })
    }
    console.log("🚀 ~ results", results)
    return results
  } catch (error) {
    console.error("Browser error:", error)
    throw error
  }
}
