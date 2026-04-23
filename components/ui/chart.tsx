"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils/cn"

// shadcn/ui chart primitives (MIT, vendored). Thin wrapper around Recharts
// that gives us:
//   - ChartContainer — ResponsiveContainer with themed class overrides
//   - ChartTooltip / ChartTooltipContent — nice dark-mode tooltip card
//   - ChartLegend / ChartLegendContent — legend with colored dots + labels
//   - A ChartConfig type tying series keys → labels + colors via CSS
//     custom properties (e.g. `var(--color-brunswick)`)
//
// Upstream reference: shadcn/ui's `chart.tsx`. Only change vs upstream:
// the `cn` import path points at our utils location.

const THEMES = { light: "", dark: ".dark" } as const

const INITIAL_DIMENSION = { width: 320, height: 200 } as const

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
>

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }
  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"]
  initialDimension?: { width: number; height: number }
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        // Theme mapping from shadcn's default tokens → JPS tokens:
        //   muted-foreground → ink-mute  (axis ticks)
        //   border           → line      (grid + cursor lines)
        //   border/50        → line-soft
        //   muted            → bg-elev   (tooltip cursor background)
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-ink-mute [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-line-soft [&_.recharts-curve.recharts-tooltip-cursor]:stroke-line [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-line [&_.recharts-radial-bar-background-sector]:fill-bg-elev [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-bg-elev/40 [&_.recharts-reference-line_[stroke='#ccc']]:stroke-line [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer
          initialDimension={initialDimension}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(
    ([, config]) => config.theme ?? config.color,
  )
  if (!colorConfig.length) return null
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color =
      itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ??
      itemConfig.color
    return color ? `  --color-${key}: ${color};` : null
  })
  .join("\n")}
}
`,
          )
          .join("\n"),
      }}
    />
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

type TooltipPayload = {
  dataKey?: string | number
  name?: string | number
  value?: number | string | null
  color?: string
  type?: string
  payload?: Record<string, unknown> & { fill?: string }
}

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: {
  active?: boolean
  payload?: TooltipPayload[]
  className?: string
  indicator?: "line" | "dot" | "dashed"
  hideLabel?: boolean
  hideIndicator?: boolean
  label?: React.ReactNode
  labelFormatter?: (
    value: React.ReactNode,
    payload: TooltipPayload[],
  ) => React.ReactNode
  labelClassName?: string
  formatter?: (
    value: number | string,
    name: string | number,
    item: TooltipPayload,
    index: number,
    rawPayload: TooltipPayload["payload"],
  ) => React.ReactNode
  color?: string
  nameKey?: string
  labelKey?: string
}) {
  const { config } = useChart()

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null
    const [item] = payload
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`
    const itemConfig = getPayloadConfigFromPayload(config, item, key)
    const value =
      !labelKey && typeof label === "string"
        ? (config[label]?.label ?? label)
        : itemConfig?.label
    if (labelFormatter) {
      return (
        <div className={cn("font-medium", labelClassName)}>
          {labelFormatter(value, payload)}
        </div>
      )
    }
    if (!value) return null
    return <div className={cn("font-medium", labelClassName)}>{value}</div>
  }, [
    label,
    labelFormatter,
    payload,
    hideLabel,
    labelClassName,
    config,
    labelKey,
  ])

  if (!active || !payload?.length) return null

  const nestLabel = payload.length === 1 && indicator !== "dot"

  return (
    <div
      className={cn(
        // JPS tokens: bg-elev for background, line for border, ink for text.
        "grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-line bg-bg-elev px-2.5 py-1.5 text-xs shadow-xl",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`
            const itemConfig = getPayloadConfigFromPayload(config, item, key)
            const indicatorColor = color ?? item.payload?.fill ?? item.color
            return (
              <div
                key={index}
                className={cn(
                  "flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-ink-mute",
                  indicator === "dot" && "items-center",
                )}
              >
                {formatter && item?.value != null && item.name != null ? (
                  formatter(
                    item.value,
                    item.name,
                    item,
                    index,
                    item.payload,
                  )
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          className={cn(
                            "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                            {
                              "h-2.5 w-2.5": indicator === "dot",
                              "w-1": indicator === "line",
                              "w-0 border-[1.5px] border-dashed bg-transparent":
                                indicator === "dashed",
                              "my-0.5": nestLabel && indicator === "dashed",
                            },
                          )}
                          style={
                            {
                              "--color-bg": indicatorColor,
                              "--color-border": indicatorColor,
                            } as React.CSSProperties
                          }
                        />
                      )
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between leading-none",
                        nestLabel ? "items-end" : "items-center",
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-ink-dim">
                          {itemConfig?.label ?? String(item.name ?? "")}
                        </span>
                      </div>
                      {item.value != null && (
                        <span className="font-mono font-medium text-ink tabular-nums">
                          {typeof item.value === "number"
                            ? item.value.toLocaleString()
                            : String(item.value)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: {
  className?: string
  hideIcon?: boolean
  nameKey?: string
  payload?: Array<{
    dataKey?: string | number
    value?: React.ReactNode
    color?: string
    type?: string
  }>
  verticalAlign?: "top" | "middle" | "bottom"
}) {
  const { config } = useChart()
  if (!payload?.length) return null
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4 flex-wrap",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item, index) => {
          const key = `${nameKey ?? item.dataKey ?? "value"}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)
          return (
            <div
              key={index}
              className={cn(
                "flex items-center gap-1.5 text-ink-dim [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-ink-mute",
              )}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: item.color }}
                />
              )}
              {itemConfig?.label ?? String(item.value ?? "")}
            </div>
          )
        })}
    </div>
  )
}

function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: unknown,
  key: string,
) {
  if (typeof payload !== "object" || payload === null) return undefined
  const payloadPayload =
    "payload" in payload &&
    typeof (payload as { payload?: unknown }).payload === "object" &&
    (payload as { payload?: unknown }).payload !== null
      ? ((payload as { payload?: unknown }).payload as Record<string, unknown>)
      : undefined
  let configLabelKey: string = key
  if (
    key in (payload as Record<string, unknown>) &&
    typeof (payload as Record<string, unknown>)[key] === "string"
  ) {
    configLabelKey = (payload as Record<string, unknown>)[key] as string
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key] === "string"
  ) {
    configLabelKey = payloadPayload[key] as string
  }
  return configLabelKey in config ? config[configLabelKey] : config[key]
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
}
