/**
 * A template is remounted on every navigation (a layout is not), so the entrance animation plays
 * each time a page arrives instead of only on the first load.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-page">{children}</div>;
}
