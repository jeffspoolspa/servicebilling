import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Jeff's Internal",
  description: "Internal operations app for Jeff's Pool & Spa Service",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
