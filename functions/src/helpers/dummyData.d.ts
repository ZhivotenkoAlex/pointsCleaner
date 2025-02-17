interface ImageItem {
  image: string
  number: string
}

interface NewspaperItem {
  origin_id: string
  image: string
  start_date: string
  end_date: string
  urlname: string
  imageList: ImageItem[]
}

interface DummyData {
  [company: string]: NewspaperItem[]
}

export const dummyData: DummyData
