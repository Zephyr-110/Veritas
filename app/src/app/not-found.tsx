export default function NotFound() {
  return (
    <div className="rounded-xl border border-line bg-panel p-10 text-center">
      <div className="text-3xl font-bold tracking-tight text-white">Page not found</div>
      <p className="mt-2 text-sm text-mute">Head back to the market list.</p>
      <a href="/" className="mt-6 inline-block text-accent underline">
        Home
      </a>
    </div>
  );
}
