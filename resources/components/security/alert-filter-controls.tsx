/**
 * The Alert history filter controls. Desktop lays them out on the card header;
 * phones stack them as FilterFields inside the shared FiltersDrawer.
 */
import { X } from "lucide-react"
import { FilterField, FilterRow } from "@/components/data/filter-rail"
import { FilterChip } from "@/components/data/tag-input"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  ALERT_KIND_OPTIONS,
  BOT_SCENARIO_NOTE,
  KIND_FILTER_NEEDS_NOTE,
  MAX_ALERT_SCENARIOS,
  type AlertFilterGroup,
  type AlertKindFilter,
} from "@/lib/crowdsec-alerts"

export function AlertKindRadioGroup({
  kind,
  onChange,
}: {
  kind: AlertKindFilter
  onChange: (kind: AlertKindFilter) => void
}) {
  return (
    <FilterField label="Kind" group>
      <RadioGroup aria-label="Alert kind" value={kind} onValueChange={(value) => onChange(value as AlertKindFilter)} className="gap-1">
        {ALERT_KIND_OPTIONS.map((option) => (
          <label key={option.key} className="flex items-start gap-3 py-1.5 pointer-coarse:py-2">
            <RadioGroupItem value={option.key} className="mt-0.5" />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm normal-case tracking-normal text-foreground">{option.label}</span>
              {option.description && (
                <span className="text-xs normal-case tracking-normal text-muted-foreground">{option.description}</span>
              )}
            </span>
          </label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{KIND_FILTER_NEEDS_NOTE}</p>
    </FilterField>
  )
}

export function AlertScenarioFilter({
  inDrawer,
  disabled,
  options,
  selected,
  onChange,
  labelFor,
  loading,
  emptyText,
  onOpenChange,
}: {
  inDrawer: boolean
  disabled: boolean
  options: string[]
  selected: string[]
  onChange: (picked: string[]) => void
  labelFor: (scenario: string) => string
  loading: boolean
  emptyText: string
  onOpenChange: (open: boolean) => void
}) {
  const combobox = (
    <FilterCombobox
      label="Scenario"
      options={options}
      selected={selected}
      onChange={onChange}
      labelFor={labelFor}
      loading={loading}
      emptyText={emptyText}
      contentClassName="min-w-72"
      onOpenChange={onOpenChange}
      disabled={disabled}
      maxSelected={MAX_ALERT_SCENARIOS}
      forceInline={inDrawer}
    />
  )
  if (!inDrawer) return <span title={disabled ? BOT_SCENARIO_NOTE : undefined}>{combobox}</span>
  return (
    <FilterField label="Scenario" group>
      {combobox}
      {disabled && <p className="text-xs text-muted-foreground">{BOT_SCENARIO_NOTE}</p>}
    </FilterField>
  )
}

export function AlertIpFilter({
  inDrawer,
  text,
  applied,
  onTextChange,
  onApply,
  onClear,
}: {
  inDrawer: boolean
  text: string
  applied: string | undefined
  onTextChange: (text: string) => void
  onApply: () => void
  onClear: () => void
}) {
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onApply()
      }}
    >
      <InputGroup className={inDrawer ? "h-8 w-full pointer-coarse:h-10" : "h-8 w-[180px]"}>
        <InputGroupInput
          name="ip"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="Filter by IP (Enter)"
          aria-label="Filter alerts by IP"
        />
        {applied && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="Clear IP filter" onClick={onClear}>
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </form>
  )
  return inDrawer ? <FilterField label="IP address">{form}</FilterField> : form
}

export function AlertFilterChips({
  chips,
  onRemove,
}: {
  chips: { group: AlertFilterGroup; label: string }[]
  onRemove: (group: AlertFilterGroup) => void
}) {
  if (chips.length === 0) return null
  return (
    <FilterRow>
      {chips.map((chip) => (
        <FilterChip key={chip.group} value={chip.label} onRemove={() => onRemove(chip.group)} />
      ))}
    </FilterRow>
  )
}
