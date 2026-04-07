import { Rail } from "@/components/shell/rail"
import { Nav } from "@/components/shell/nav"

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_240px_1fr] min-h-screen">
      <Rail />
      <Nav />
      <main className="flex flex-col min-w-0">{children}</main>
    </div>
  )
}
