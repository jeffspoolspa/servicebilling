"use client"

import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { cn } from "@/lib/utils/cn"

/**
 * House slider (Radix) — cyan range on a dark track, touch-sized thumb.
 * Single-value; pass min/max/step/value/onValueChange like the primitive.
 */
export const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(function Slider({ className, ...props }, ref) {
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        "relative flex w-full touch-none select-none items-center py-2.5",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-black/40 border border-line-soft">
        <SliderPrimitive.Range className="absolute h-full bg-gradient-to-r from-cyan-deep to-cyan" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          "block h-5 w-5 rounded-full bg-white border-2 border-cyan",
          "shadow-[0_2px_8px_rgba(0,0,0,0.5)]",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40",
          "active:scale-110 transition-transform duration-100",
        )}
      />
    </SliderPrimitive.Root>
  )
})
