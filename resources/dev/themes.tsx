/** Development-only component gallery. Not an application route or build entry. */
import { useId } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider, useTheme } from "@/components/theme-provider"
import { ModeToggle } from "@/components/mode-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerTrigger } from "@/components/ui/drawer"
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MapOverlay } from "@/components/map/MapOverlay"
import { ACCENTS } from "@/lib/accent"
import { DARK_APPEARANCES, DARK_APPEARANCE_CATALOG } from "@/lib/theme"

function Controls() {
  const id = useId()
  return (
    <div className="space-y-4">
      <Tabs defaultValue="markers">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="heatmap">Heatmap</TabsTrigger>
          <TabsTrigger value="markers">Markers</TabsTrigger>
          <TabsTrigger value="banned">Banned</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-2">
        <Badge variant="secondary">13</Badge>
        <span className="text-sm">Count badge</span>
        <Badge variant="destructive">Banned</Badge>
      </div>
      <div className="space-y-1">
        <label htmlFor={id} className="text-sm">Search country</label>
        <Input id={id} placeholder="Country name" />
      </div>
      <Select defaultValue="all">
        <SelectTrigger aria-label="Country filter" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All countries</SelectItem>
          <SelectItem value="no">Norway</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center justify-between border-t border-border/50 pt-3 text-sm">
        Live <Switch aria-label="Live" defaultChecked />
      </div>
    </div>
  )
}

function Gallery() {
  const { theme, setTheme, darkAppearance, setDarkAppearance, accent, setAccent } = useTheme()
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
      <h1 className="text-xl font-semibold">Theme component preview</h1>
      <ModeToggle />
      <div className="flex flex-wrap gap-2" aria-label="Preview palette">
        <Button variant="outline" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light</Button>
        {DARK_APPEARANCES.map((id) => (
          <Button key={id} variant="outline" aria-pressed={theme === "dark" && darkAppearance === id}
            onClick={() => { setDarkAppearance(id); setTheme("dark") }}>
            {DARK_APPEARANCE_CATALOG[id].label}
          </Button>
        ))}
        <Button variant="outline" onClick={() => setTheme("system")}>System</Button>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Preview accent">
        {ACCENTS.map((id) => <Button key={id} variant="outline" aria-pressed={accent === id} onClick={() => setAccent(id)}>{id}</Button>)}
      </div>
      <div data-testid="card" className="space-y-4 rounded-xl bg-card p-4 ring-1 ring-border">
        <h2 className="font-medium">Card controls</h2>
        <p className="text-muted-foreground">Muted text, grouped controls, and secondary fills.</p>
        <Controls />
      </div>
      <div className="flex gap-3">
        <Drawer>
          <DrawerTrigger asChild><Button variant="outline">Open drawer</Button></DrawerTrigger>
          <DrawerContent>
            <DrawerHeader><DrawerTitle>Preview drawer</DrawerTitle><DrawerDescription>Check the handle, tabs, badges, and dividers.</DrawerDescription></DrawerHeader>
            <div className="overflow-auto p-4"><Controls /></div>
          </DrawerContent>
        </Drawer>
        <Dialog>
          <DialogTrigger asChild><Button variant="outline">Open dialog</Button></DialogTrigger>
          <DialogContent>
            <DialogTitle>Preview dialog</DialogTitle><DialogDescription>Check controls on an elevated panel.</DialogDescription>
            <Controls />
          </DialogContent>
        </Dialog>
      </div>
      <div data-testid="map" className="relative h-[30rem] overflow-hidden rounded-xl"
        style={{ background: "repeating-linear-gradient(45deg, #283a45 0 32px, #14232a 32px 64px)" }}>
        <MapOverlay placement="top-right" className="w-[min(20rem,calc(100%-2rem))] p-4" aria-label="Preview map panel" role="complementary">
          <Controls />
        </MapOverlay>
      </div>
    </main>
  )
}

createRoot(document.getElementById("app")!).render(<ThemeProvider defaultTheme="dark"><Gallery /></ThemeProvider>)
