import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/access-logs')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/access-logs"!</div>
}
