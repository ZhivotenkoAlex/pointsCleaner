import express from "express"
import { dummyData } from "../helpers/dummyData.js"
import { getError } from "../helpers/timestampToDate"
import { start, saveToFirebase } from "../services/scan"

// eslint-disable-next-line new-cap
const router = express.Router()

router.get("/start", async (req: express.Request, res: express.Response) => {
  try {
    const result = await start()
    res.status(200).send(result)
  } catch (error) {
    res.status(500).json({ message: getError(error) })
  }
})

router.get("/save", async (req, res) => {
  try {
    const result = await saveToFirebase(dummyData)
    res.status(200).send(result)
  } catch (error) {
    res.status(500).json({ message: getError(error) })
  }
})

export default router
