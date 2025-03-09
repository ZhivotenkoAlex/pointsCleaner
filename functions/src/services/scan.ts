import { db } from "../index"
import puppeteer from "puppeteer-core"
import { getStorage } from "firebase-admin/storage"
import { WriteBatch } from "firebase-admin/firestore"
import sharp from "sharp"
import chromium from "chromium"

const { fetch } = globalThis

interface NewspaperData {
  origin_id: string | null
  image: string
  start_date: string
  end_date: string
  urlname: string
  imageList: { image: string | null; number: string }[]
}

interface BrochureData {
  id?: string
  description: string
  end_date: string
  start_date: string
  image: string
  is_removed: string
  name: string
  origin_id: string
  supplier_id?: string
  urlname: string
  created_at: string
}

interface GazetkiBcData {
  id?: string
  brochure_id: string
  category_id: string
  page_number: string
}

interface GazetkiPageData {
  id?: string
  brochure_id: string
  supplier_id: string
  number: string
  image: string
}

const url = "https://www.gazetkipromocyjne.net/sitemap_index.xml"
const originName = "https://www.gazetkipromocyjne.net"

/**
 * Retrieves a bill.
 * @param {string} billId The bill id.
 * @return {Promise<any>} The bill object or null if not found.
 */
export async function start() {
  console.time("Duration")

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium.path,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--disable-gpu",
      "--no-zygote",
      "--disable-software-rasterizer",
      "--disable-extensions",
    ],
  })
  const page = await browser.newPage()
  await page.goto(url)
  await page.setViewport({ width: 1080, height: 1024 })
  await page.waitForSelector("a")
  const links = await page.$$eval("a", (elements) =>
    elements.map((el) => el.href)
  )

  const sitemapLinks = links.filter((link) => link.includes(originName))
  const secondLink = sitemapLinks[1]

  await page.goto(secondLink)
  await page.waitForSelector("a")
  const brochureLinks = await page.$$eval("a", (elements) =>
    elements.map((el) => el.href)
  )

  const filteredBrochureLinks = brochureLinks.filter((link) =>
    link.includes(originName)
  )

  const newspapers = {} as { [key: string]: Partial<NewspaperData>[] }

  for (const link of filteredBrochureLinks) {
    await page.goto(link)

    const hasNewspapersClass = await page.evaluate(() => {
      return !!document.querySelector(".newspappers")
    })

    if (hasNewspapersClass) {
      const match = link.match(/\/([^/]+)\/$/)
      if (!match) continue

      const companyName = match[1].replace("gazetka-promocyjna-", "").trim()
      newspapers[companyName] = []

      const newspaperData = await page.$$eval(".newspapper", (elements) => {
        return elements.map((el) => {
          const imgElement = el.querySelector(
            "div.newspapper-img"
          ) as HTMLElement | null

          let imageUrl = ""

          if (imgElement) {
            const image = imgElement.getAttribute("data-bg") || ""
            const cleanUrl = image.replace(/&quot;/g, "")

            imageUrl = cleanUrl.startsWith("/")
              ? "https://www.gazetkipromocyjne.net" + cleanUrl
              : cleanUrl

            if (!imageUrl) {
              console.error("No valid background image found for newspaper", {
                element: imgElement.outerHTML,
              })
            }
          } else {
            console.error("Could not find div.newspapper-img element")
          }

          const newspaperId =
            imgElement?.getAttribute("rel")?.split("#id")[1] || null
          const footerElement = el.querySelector(".newspapper-footer p")
          const dateText = footerElement?.textContent || ""
          const [startDate, endDate] = dateText.split("–").map((d) => d.trim())

          return {
            origin_id: newspaperId,
            image: imageUrl,
            start_date: startDate,
            end_date: endDate,
            urlname: "",
            imageList: [],
          } as NewspaperData
        })
      })

      const newspapers_elements = await page.$$(".newspapper")

      for (let i = 0; i < newspapers_elements.length; i++) {
        try {
          await Promise.all([
            page.waitForNavigation({
              waitUntil: "networkidle0",
            }),
            page.evaluate((index) => {
              const buttons = document.querySelectorAll(".newspapper-btn")
              ;(buttons[index] as HTMLElement).click()
            }, i),
          ])

          await page.waitForSelector("iframe")

          const frames = page.frames()

          const contentFrame = frames.find((frame) =>
            frame.url().includes("gazetkipromocyjne.net/wp-content/themes")
          )
          if (!contentFrame) {
            console.error("Could not find content frame")
            continue
          }

          await contentFrame.waitForSelector("body")

          const imageLinks = await contentFrame.evaluate(() => {
            const images = document.querySelectorAll("img")
            return Array.from(images).map((img, index) => ({
              image:
                "https://www.gazetkipromocyjne.net" + img.getAttribute("src"),
              number: String(index + 1),
            }))
          })

          if (!imageLinks.length) {
            console.error("No images found on page")
          }

          const startDate = newspaperData[i]["start_date"]
          const formattedDate = formatDate(startDate)

          newspaperData[i].urlname =
            `gazetka-${companyName}-od-${formattedDate}`
          newspaperData[i].imageList = imageLinks

          await Promise.all([
            page.waitForNavigation({
              waitUntil: "networkidle0",
            }),
            page.goBack(),
          ])

          await page.waitForSelector(".newspapper")
        } catch (navigationError) {
          console.error(`Navigation error for newspaper ${i}:`, navigationError)
          try {
            await page.goto(link)
            await page.waitForSelector(".newspapper")
          } catch (recoveryError) {
            console.error(
              "Failed to recover from navigation error:",
              recoveryError
            )
            continue
          }
        }
      }

      console.log(` 'newspapers' is found at: ${link}`)

      newspapers[companyName] = newspaperData
    } else {
      console.log(`No 'newspapers' class found at: ${link}`)
    }
  }

  await browser.close()
  console.timeEnd("Duration")
  const results = await saveToFirebase(newspapers)
  // return newspapers

  return results
}

interface ChunkResult {
  brochure: BrochureData | null
  brochureBc: GazetkiBcData | null
  gazetkiPages: GazetkiPageData[] | null
}

/**
 * The function `saveToFirebase` processes newspaper data and uploads images to Firebase storage,
 * returning data for the company named "obi".
 *@param {Object.<string, Partial<unknown>[]>} newspapers  - The `saveToFirebase` function takes in a parameter `newspapers`, which is an
 * object where each key represents a company name and the corresponding value is an array of partial
 * objects. These partial objects likely contain information about newspapers associated with each
 * company.
 * @return {any} The function `saveToFirebase` is returning the data for the company named "obi" after
 * processing the newspapers data provided as input.
 */
export async function saveToFirebase(
  newspapers: Record<string, Partial<NewspaperData>[]>
) {
  try {
    const data = await Promise.all(
      Object.entries(newspapers).map(async ([company, papers]) => {
        const companyName = getName(company)
        const supplier_id = await getSupplierId(companyName)
        const categoryId = await getCategoryId(company)

        if (!supplier_id || !categoryId) {
          console.error("Supplier or category not found", {
            companyName,
            supplier_id,
            categoryId,
          })
          return []
        }

        return papers.map((paper) => ({
          ...paper,
          name: companyName,
          supplier_id,
          categoryId,
        }))
      })
    )

    const flatData = data.flat()
    // const obiData = flatData.filter((item) => item.name === "tedi")
    const results: ChunkResult[] = []

    for (const item of flatData) {
      try {
        const batch = db.batch()

        const brochure = await saveGazetkiBrochure(item as any, batch)

        if (brochure && brochure.id) {
          const brochureBc = await saveGazetkiBc(
            brochure.id,
            item.categoryId as string,
            batch
          )
          const gazetkiPages = await Promise.all(
            item.imageList?.map(async (page) => {
              if (!page.image) return null
              return saveGazetkiPage(
                brochure.id as string,
                item.supplier_id as string,
                [{ image: page.image, number: page.number }],
                item.urlname as string,
                item.origin_id as string,
                batch
              )
            }) || []
          ).then((results) =>
            results
              .flat()
              .filter((page): page is GazetkiPageData => page !== null)
          )

          await batch.commit()
          results.push({ brochure, brochureBc, gazetkiPages })
        } else {
          results.push({ brochure: null, brochureBc: null, gazetkiPages: null })
        }
      } catch (error) {
        console.error("Error processing item:", error)
        results.push({ brochure: null, brochureBc: null, gazetkiPages: null })
      }
    }

    return results
  } catch (error) {
    console.error("Error in saveToFirebase:", error)
    throw error
  }
}

const getName = (company: string) => {
  let companyName
  switch (company) {
    case "super-pharm":
      companyName = company
      break
    case "e-leclerc":
      companyName = "leclerc"
      break
    case "zabka":
      companyName = "żabka"
      break
    case "jawa":
      companyName = "drogerie jawa"
      break
    case "natura":
      companyName = "drogerie natura"
      break
    default:
      companyName = company.split("-").join(" ")
  }
  return companyName
}

const getSupplierId = async (company: string) => {
  const supplier = await db
    .collection("gazetki_supplier")
    .where("name", "==", getName(company))
    .get()
  return supplier.docs[0]?.data()?.id || null
}

const getCategoryId = async (company: string) => {
  const category = await db
    .collection("gazetki_category")
    .where("name", "==", getName(company))
    .get()
  return category.docs[0]?.data()?.id || null
}

const formatDate = (date: string) => {
  const [day, month, year] = date.split("/")
  return `${year}-${month}-${day}`
}

/**
 * The function `uploadImageToStorage` uploads an image from a URL to a cloud storage bucket and
 * returns the public URL of the uploaded image.
 * @param {string} imageUrl - The `imageUrl` parameter is a string that represents the URL of the image
 * you want to upload to a cloud storage service.
 * @param {string} path - The `path` parameter in the `uploadImageToStorage` function represents the
 * location or path where you want to store the image in the cloud storage service. It could be a
 * specific folder or directory structure within the storage bucket where the image will be saved. For
 * example, if you want to save
 * @return { any } The function `uploadImageToStorage` returns a Promise that resolves to a string. The string
 * returned is either the URL of the uploaded image in the storage bucket (if the upload is successful)
 * or the original `imageUrl` (if the upload fails).
 */
async function uploadImageToStorage(
  imageUrl: string,
  path: string
): Promise<string> {
  const storage = getStorage()
  const bucket = storage.bucket()

  try {
    // Add user agent and timeout to fetch
    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    })

    if (!response.ok) {
      console.error(
        `Failed to fetch image: ${response.status} for URL: ${imageUrl}`
      )
      throw new Error(`Failed to fetch image: ${response.status}`)
    }

    const buffer = await response.arrayBuffer()

    // Add error handling for sharp
    try {
      const optimizedBuffer = await sharp(Buffer.from(buffer))
        .jpeg({ quality: 80 })
        .resize(1200, null, { withoutEnlargement: true })
        .toBuffer()

      const file = bucket.file(path)
      await file.save(optimizedBuffer, {
        contentType: "image/jpeg",
        public: true,
      })

      return `https://storage.googleapis.com/${bucket.name}/${path}`
    } catch (sharpError) {
      console.error("Sharp processing error:", sharpError)
      // If sharp fails, try to upload original buffer
      const file = bucket.file(path)
      await file.save(Buffer.from(buffer), {
        contentType: "image/jpeg",
        public: true,
        metadata: {
          cacheControl: "public, no-cache",
        },
      })
      return `https://storage.googleapis.com/${bucket.name}/${path}`
    }
  } catch (error) {
    console.error("Error uploading image:", error, "URL:", imageUrl)
    return imageUrl // Return original URL as fallback
  }
}

/**
 * The function `uploadImageBatch` asynchronously uploads multiple images to a storage location.
 * @param {any} images - An array of objects, where each object has two properties:
 * @return {any} The `uploadImageBatch` function is returning a Promise that resolves when all the images in
 * the input array have been uploaded to storage using the `uploadImageToStorage` function.
 */
async function uploadImageBatch(images: Array<{ url: string; path: string }>) {
  const promises = images.map((img) => uploadImageToStorage(img.url, img.path))
  return Promise.all(promises)
}

const getBrochureName = (urlName: string): string => {
  return urlName
    .split("-")
    .map((word) => {
      if (word === "od") return word
      if (word.includes("-")) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(" ")
}

const saveGazetkiBrochure = async (item: BrochureData, batch: WriteBatch) => {
  try {
    if (!item.image) {
      console.error("Missing image URL:", item)
      return null
    }

    if (
      !item.end_date ||
      !item.start_date ||
      !item.urlname ||
      !item.supplier_id
    ) {
      console.error("Invalid item data:", item)
      return null
    }

    if (await isGazetkaExists(item.origin_id, item.supplier_id)) {
      return null
    }

    const imagePath = `users/uploads/newspapers/${item.urlname}-${item.origin_id}/${item.urlname}.png`
    const imageUrl = await uploadImageToStorage(item.image, imagePath)

    const brochureData: BrochureData = {
      description: "",
      end_date: formatDate(item.end_date),
      start_date: formatDate(item.start_date),
      created_at: new Date().toISOString().split("T")[0],
      image: imageUrl,
      origin_id: item.origin_id,
      is_removed: "0",
      name: getBrochureName(item.urlname),
      supplier_id: item.supplier_id,
      urlname: item.urlname,
    }

    const docRef = db.collection("gazetki_brochure").doc()
    brochureData["id"] = docRef.id
    batch.set(docRef, brochureData)

    return brochureData
  } catch (error) {
    console.error("Error processing item:", error)
    return null
  }
}

const saveGazetkiBc = async (
  brochure_id: string,
  category_id: string,
  batch: WriteBatch
): Promise<GazetkiBcData | null> => {
  try {
    if (!brochure_id || !category_id) {
      console.error("Invalid item data:")
      return null
    }

    const brochureBcData: GazetkiBcData = {
      brochure_id: brochure_id,
      category_id: category_id,
      page_number: "0",
    }

    const docRef = db.collection("gazetki_bc").doc()
    brochureBcData["id"] = docRef.id
    batch.set(docRef, brochureBcData)

    return brochureBcData
  } catch (error) {
    console.error("Error processing item:", error)
    return null
  }
}

const saveGazetkiPage = async (
  brochure_id: string,
  supplier_id: string,
  pages: Array<{ image: string; number: string }>,
  urlname: string,
  origin_id: string,
  batch: WriteBatch
): Promise<GazetkiPageData[]> => {
  try {
    const imageUploads = pages.map((page) => ({
      url: page.image,
      path: `users/uploads/newspapers/${urlname}-${origin_id}/${urlname}/${page.number}.png`,
    }))

    const imageUrls = await uploadImageBatch(imageUploads)

    return pages.map((page, index) => {
      const gazetkiPageData: GazetkiPageData = {
        brochure_id,
        supplier_id,
        number: page.number,
        image: imageUrls[index],
      }

      const docRef = db.collection("gazetki_page").doc()
      gazetkiPageData.id = docRef.id
      batch.set(docRef, gazetkiPageData)

      return gazetkiPageData
    })
  } catch (error) {
    console.error("Error processing pages:", error)
    return []
  }
}

const isGazetkaExists = async (origin_id: string, supplier_id: string) => {
  const gazetka = await db
    .collection("gazetki_brochure")
    .where("origin_id", "==", origin_id)
    .where("supplier_id", "==", supplier_id)
    .where("is_removed", "==", "0")
    .get()

  return gazetka.docs.length > 0
}
