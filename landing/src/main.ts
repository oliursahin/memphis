// Rotating subtitle words
const options = [
  "yours",
  "fast",
  "private",
  "keyboard-first",
  "local-first",
  "open source",
  "lightweight",
];

const subtitle = document.querySelector(".hero-subtitle");
const rotator = document.querySelector(".hero-rotator");

if (subtitle && rotator) {
  let index = 0;

  function rotate() {
    index = (index + 1) % options.length;
    rotator!.classList.add("is-fading");

    rotator!.addEventListener(
      "transitionend",
      function swap() {
        rotator!.removeEventListener("transitionend", swap);
        rotator!.textContent = options[index];
        subtitle!.setAttribute(
          "aria-label",
          `There are many email clients, but this one is ${options[index]}.`
        );
        rotator!.classList.remove("is-fading");
      }
    );
  }

  setInterval(rotate, 3200);
}