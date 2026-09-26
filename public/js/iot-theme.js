document.addEventListener("DOMContentLoaded", () => {
  const body = document.body;
  const toggle = document.querySelector("[data-iot-sidebar-toggle]");
  const backdrop = document.querySelector(".iot-mobile-backdrop");

  const isMobile = () => window.matchMedia("(max-width: 767.98px)").matches;

  toggle?.addEventListener("click", () => {
    if (isMobile()) {
      body.classList.toggle("iot-mobile-open");
    } else {
      body.classList.toggle("iot-sidebar-collapsed");
      localStorage.setItem(
        "iot-sidebar-collapsed",
        body.classList.contains("iot-sidebar-collapsed") ? "1" : "0"
      );
    }
  });

  backdrop?.addEventListener("click", () => body.classList.remove("iot-mobile-open"));

  if (!isMobile() && localStorage.getItem("iot-sidebar-collapsed") === "1") {
    body.classList.add("iot-sidebar-collapsed");
  }

  window.addEventListener("resize", () => {
    if (!isMobile()) body.classList.remove("iot-mobile-open");
  });
});
