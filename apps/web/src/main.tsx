import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { HomePage } from "./routes/HomePage";
import { FilePage } from "./routes/FilePage";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route index element={<HomePage />} />
        <Route path="/files/:id" element={<FilePage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
