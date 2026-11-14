/** A spinner with words, for anything the app has to wait on. */
export default function Loader({ label, large = false }: { label: string; large?: boolean }) {
  return (
    <div className={`loader ${large ? 'large' : ''}`} role="status">
      <span className="loader-ring" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** The same, over the whole window, while something like an album is opening. */
export function LoaderScreen({ label }: { label: string }) {
  return (
    <div className="loader-screen">
      <Loader label={label} large />
    </div>
  );
}
