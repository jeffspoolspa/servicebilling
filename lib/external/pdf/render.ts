import chromium from "@sparticuz/chromium"
import puppeteer from "puppeteer-core"

/**
 * HTML -> PDF inside the app's own serverless function. @sparticuz/chromium
 * is a lambda-packaged chromium binary, so the letter renders with the same
 * engine a browser's print dialog uses — no external render service. On a
 * mac dev machine the lambda binary can't run, so we drive the locally
 * installed Chrome instead.
 */
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch(
    process.platform === "darwin"
      ? { executablePath: MAC_CHROME, headless: true }
      : { args: chromium.args, executablePath: await chromium.executablePath(), headless: true },
  )
  try {
    const page = await browser.newPage()
    // The letter is self-contained (inline CSS, no remote assets), so
    // "load" is the full render.
    await page.setContent(html, { waitUntil: "load", timeout: 45000 })
    const pdf = await page.pdf({ format: "letter", printBackground: true })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
