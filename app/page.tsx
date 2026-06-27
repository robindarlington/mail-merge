export default function Home() {
  return (
    <main
      style={{
        display: "flex",
        minHeight: "100vh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>
        Mail Merge — foundation
      </h1>
      <p style={{ opacity: 0.7 }}>
        Phase 1 scaffold. No user-facing features yet.
      </p>
    </main>
  );
}
