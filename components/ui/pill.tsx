import { type HTMLAttributes } from "react"
import { cn } from "@/lib/utils/cn"

type Tone = "neutral" | "cyan" | "teal" | "sun" | "coral" | "grass" | "indigo"

const tones: Record<Tone, string> = {
  neutral: "text-ink-mute bg-white/5 border-line",
  cyan: "text-cyan bg-cyan/10 border-cyan/20",
  teal: "text-teal bg-teal/10 border-teal/20",
  sun: "text-sun bg-sun/10 border-sun/20",
  coral: "text-coral bg-coral/10 border-coral/20",
  grass: "text-grass bg-grass/10 border-grass/20",
  indigo: "text-indigo-300 bg-indigo-400/10 border-indigo-400/20",
}

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
  dot?: boolean
}

export function Pill({ className, tone = "neutral", dot = false, children, ...props }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border",
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}
