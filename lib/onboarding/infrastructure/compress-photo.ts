/**
 * Browser-side: a picked file ready for the staging bucket. Photos are
 * re-encoded as a compressed JPEG (max 2200 px); PDFs pass through. Used by
 * the candidate upload page and the staff candidate page.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export interface Picked {
  id: string
  name: string
  file: Blob
  type: string
  size: number
}

export async function prepare(file: File): Promise<Picked> {
  const id = Math.random().toString(36).slice(2)
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is over 20 MB. Please upload a smaller file.`)
    return { id, name: file.name, file, type: "application/pdf", size: file.size }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`We couldn't read ${file.name}. Take a new photo, or upload a JPG or PDF.`))
      el.src = url
    })
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process the photo."))), "image/jpeg", 0.82),
    )
    return { id, name: file.name.replace(/\.[^.]+$/, "") + ".jpg", file: blob, type: "image/jpeg", size: blob.size }
  } finally {
    URL.revokeObjectURL(url)
  }
}
