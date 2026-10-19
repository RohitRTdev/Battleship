import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main>
      <h1>Battleship scaffold is running</h1>
      <p>The React application is ready for implementation.</p>
      <code>/api/auth/*</code>
      <code>/api/backend/*</code>
    </main>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

