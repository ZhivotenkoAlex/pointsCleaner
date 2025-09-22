import express from "express"
import * as admin from "firebase-admin"
import cors from "cors"
import { getFirestore } from "firebase-admin/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import cleaner from "./controllers/scan"
import { start } from "./services/cleaner"
import { onRequest } from "firebase-functions/v2/https"
import { getError } from "./helpers/timestampToDate"
admin.initializeApp()

export const dbInstance = getFirestore(admin.app(), "skanuj-wygrywaj")
dbInstance.settings({ ignoreUndefinedProperties: true })
export const db = dbInstance
const app = express()

app.use(cors())

app.use("/", cleaner)

export const pointsCleaner = onRequest(
  {
    timeoutSeconds: 900,
    region: "europe-central2",
    memory: "512MiB",
  },
  app
)

export const pointsCleanerSchedule = onSchedule(
  {
    schedule: "0 1 * * *",
    region: "europe-central2",
    timeZone: "Europe/Warsaw",
    timeoutSeconds: 900,
    memory: "512MiB",
    cpu: 1,
  },
  async () => {
    try {
      await start()
      console.log("Daily points cleaner completed successfully")
    } catch (error) {
      console.error("Daily points cleaner failed:", getError(error))
      throw error
    }
  }
)
