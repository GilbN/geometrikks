const darkScheme = matchMedia("(prefers-color-scheme: dark)")
const applyScheme = () => document.documentElement.classList.toggle("dark", darkScheme.matches)
applyScheme()
darkScheme.addEventListener("change", applyScheme)
