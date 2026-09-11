declare module "mapbox-gl-fps/lib/MapboxFPS.js" {
  export class FPSMeasurer {
    measurements: number[]
    startMeasuring(): void
    stopMeasuring(): void
    registerRenderFrame(): void
    updateFPS(): void
    getLastMeasurement(): number
  }
}
