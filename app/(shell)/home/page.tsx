import { Home as HomeIcon } from "lucide-react"

export const metadata = { title: "Home" }

/**
 * Placeholder home page. Will eventually surface cross-department
 * summary / news / pinned tasks; for now it just holds space so the
 * sidebar's Home link has somewhere to land.
 */
export default function HomePage() {
  return (
    <div className="flex-1 grid place-items-center px-7 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-12 h-12 rounded-full bg-cyan/10 border border-cyan/20 grid place-items-center">
          <HomeIcon className="w-5 h-5 text-cyan" strokeWidth={1.8} />
        </div>
        <div className="text-ink font-medium">Home</div>
        <div className="text-ink-mute text-[12px] max-w-sm">
          Cross-department summary lands here. For now, pick a department
          from the sidebar.
        </div>
      </div>
    </div>
  )
}
