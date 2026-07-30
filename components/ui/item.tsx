import * as React from "react"
import { cn } from "@/lib/utils/cn"

/**
 * Item — shadcn/ui's Item composition (Item / ItemMedia / ItemContent /
 * ItemTitle / ItemDescription / ItemActions / ItemGroup / ItemSeparator),
 * adapted to this app's token palette (ink/line/bg-elev) instead of the
 * shadcn theme vars, and without the cva/radix dependencies (plain props).
 * Same API shape so upstream examples translate directly.
 */

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="list"
      data-slot="item-group"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function ItemSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-separator"
      className={cn("h-px bg-line-soft my-1", className)}
      {...props}
    />
  )
}

function Item({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "outline" | "muted"
  size?: "default" | "sm" | "xs"
}) {
  return (
    <div
      data-slot="item"
      data-variant={variant}
      className={cn(
        "flex flex-wrap items-center rounded-md border text-sm transition-colors",
        variant === "outline"
          ? "border-line"
          : variant === "muted"
            ? "border-transparent bg-bg-elev/60"
            : "border-transparent bg-transparent",
        size === "xs"
          ? "gap-2 px-2.5 py-1.5"
          : size === "sm"
            ? "gap-2.5 px-3 py-2"
            : "gap-3 p-3",
        className,
      )}
      {...props}
    />
  )
}

function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "icon" | "image" }) {
  return (
    <div
      data-slot="item-media"
      className={cn(
        "flex shrink-0 items-center justify-center self-start",
        variant === "icon" &&
          "w-8 h-8 rounded-sm border border-line-soft bg-bg-elev [&_svg]:w-4 [&_svg]:h-4",
        variant === "image" && "w-10 h-10 overflow-hidden rounded-sm",
        className,
      )}
      {...props}
    />
  )
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn("flex flex-1 min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "flex w-fit items-center gap-2 text-[13px] leading-snug font-medium text-ink",
        className,
      )}
      {...props}
    />
  )
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn("text-[11px] leading-normal text-ink-mute", className)}
      {...props}
    />
  )
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("flex items-center gap-2 shrink-0", className)}
      {...props}
    />
  )
}

export {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
}
