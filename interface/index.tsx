/* @refresh reload */
import { render } from "solid-js/web";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/global.css";
import App from "./App";
import MenubarCalendar from "./pages/MenubarCalendar";

const root = document.getElementById("root");
const label = getCurrentWindow().label;

if (label === "menubar-calendar") {
  render(() => <MenubarCalendar />, root!);
} else {
  render(() => <App />, root!);
}
