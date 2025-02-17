// import * as functions from "firebase-functions"
import express from "express"
import * as admin from "firebase-admin"
import cors from "cors"
import { getFirestore } from "firebase-admin/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import scan from "./controllers/scan"
import { start } from "./services/scan"
// import { onRequest } from "firebase-functions/v2/https"
import { getError } from "./helpers/timestampToDate"
// admin.initializeApp(functions.config().firebase)
admin.initializeApp()

export const dbInstance = getFirestore(admin.app(), "skanuj-wygrywaj")
dbInstance.settings({ ignoreUndefinedProperties: true })
export const db = dbInstance
const app = express()

app.use(cors())

app.use("/", scan)

// export const gazetkiScrapper = onRequest(
//   {
//     timeoutSeconds: 900,
//     region: "europe-central2",
//     memory: "512MiB",
//   },
//   app
// )

export const gazetkiUpdates = onSchedule(
  {
    schedule: "0 0 * * *",
    region: "europe-central2",
    timeZone: "Europe/Warsaw",
    timeoutSeconds: 900,
    memory: "1GiB",
    cpu: 1,
  },
  async () => {
    try {
      await start()
      console.log("Daily scan completed successfully")
    } catch (error) {
      console.error("Daily scan failed:", getError(error))
      throw error
    }
  }
)
