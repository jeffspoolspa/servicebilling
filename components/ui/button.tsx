import { forwardRef, type ButtonHTMLAttributes } from "react"
import { cn } from "@/lib/utils/cn"

type Variant = "default" | "primary" | "ghost"
type Size = "sm" | "md"

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const variants: Record<Variant, string> = {
  default:
    "border border-line bg-bg-elev text-ink hover:border-cyan hover:text-cyan transition-colors",
  primary:
    "bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] font-medium hover:brightness-110 transition-all",
  ghost: "text-ink-dim hover:text-ink hover:bg-white/5 transition-colors",
}

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs rounded-md",
  md: "h-9 px-4 text-sm rounded-lg",
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 font-medium",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"
