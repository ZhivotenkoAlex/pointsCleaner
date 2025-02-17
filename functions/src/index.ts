import * as functions from "firebase-functions"
import express from "express"
import * as admin from "firebase-admin"
import cors from "cors"
import { getFirestore } from "firebase-admin/firestore"
import scan from "./controllers/scan"
import { onRequest } from "firebase-functions/v2/https"

admin.initializeApp(functions.config().firebase)

export const dbInstance = getFirestore(admin.app(), "skanuj-wygrywaj")
dbInstance.settings({ ignoreUndefinedProperties: true })
export const db = dbInstance
const scrapper = express()

scrapper.use(cors())

scrapper.use("/", scan)

exports.scrapper = onRequest(
  {
    timeoutSeconds: 540,
    region: "europe-central2",
    memory: "512MiB",
  },
  scrapper
)
