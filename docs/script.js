// GitHub stars
const STAR_REPO = "mightbeanshuu/vibebus";

async function loadGitHubStars() {
  const targets = document.querySelectorAll("[data-star-count]");
  if (!targets.length) return;

  try {
    const response = await fetch(`https://api.github.com/repos/${STAR_REPO}`);
    if (!response.ok) throw new Error("stars unavailable");
    const data = await response.json();
    const count = Number(data.stargazers_count ?? 0).toLocaleString();
    for (const target of targets) {
      target.textContent = count;
    }
  } catch {
    for (const target of targets) {
      target.textContent = "0";
    }
  }
}

loadGitHubStars();

const nav = document.querySelector("[data-nav]");
if (nav) {
  const onScroll = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 12);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

// Copy buttons
const buttons = document.querySelectorAll("[data-copy]");

for (const button of buttons) {
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy");
    const label = button.querySelector("span");

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }

    if (label) {
      const original = label.textContent;
      label.textContent = "Copied";
      window.setTimeout(() => {
        label.textContent = original;
      }, 1600);
    }
  });
}

// Smooth anchor scroll with offset for sticky nav
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const id = link.getAttribute("href");
    if (!id || id === "#") return;

    const target = document.querySelector(id);
    if (!target) return;

    event.preventDefault();
    const navHeight = nav?.offsetHeight ?? 0;
    const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
    window.scrollTo({ top, behavior: "smooth" });
  });
});
