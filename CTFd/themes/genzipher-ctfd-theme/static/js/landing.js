"use strict";

document.addEventListener("DOMContentLoaded", () => {
    initTimeline();
    initMobileAccordion();
    initScrollAnimations();
    initUniversityStats();
});

/* =========================================
   Timeline / Rounds Logic
   ========================================= */
function initTimeline() {
    const cards = document.querySelectorAll(".timeline-card");
    const items = document.querySelectorAll(".timeline-item");

    if (!cards.length) return;

    // Click to activate
    cards.forEach((card) => {
        card.addEventListener("click", () => {
            // Remove active from all
            items.forEach((item) => item.classList.remove("active"));
            // Add active to parent item
            const parentItem = card.closest(".timeline-item");
            if (parentItem) parentItem.classList.add("active");
        });
    });

    // Set first as active by default
    if (items.length > 0) items[0].classList.add("active");
}

/* =========================================
   Mobile Accordion Logic
   ========================================= */
function initMobileAccordion() {
    const toggles = document.querySelectorAll(".accordion-toggle");

    toggles.forEach((btn) => {
        btn.addEventListener("click", () => {
            const content = btn.nextElementSibling;
            const icon = btn.querySelector(".toggle-icon");
            const text = btn.querySelector(".toggle-text");

            const isOpen = content.style.maxHeight !== "0px" && content.style.maxHeight !== "";

            if (isOpen) {
                // Close
                content.style.maxHeight = "0px";
                content.style.opacity = "0";
                icon.style.transform = "rotate(0deg)";
                icon.textContent = "+";
                text.textContent = "Reveal mission";
            } else {
                // Open - Close others? (Optional, let's keep it allowing multiple open)
                content.style.maxHeight = content.scrollHeight + "px";
                content.style.opacity = "1";
                icon.style.transform = "rotate(45deg)";
                icon.textContent = "+";
                text.textContent = "Hide brief";
            }
        });
    });
}

/* =========================================
   Scroll Animations (IntersectionObserver)
   ========================================= */
function initScrollAnimations() {
    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add("visible");
                    // optional: observer.unobserve(entry.target);
                }
            });
        },
        { threshold: 0.1, rootMargin: "0px 0px -50px 0px" }
    );

    const animatedElements = document.querySelectorAll(".fade-in-up, .timeline-item");
    animatedElements.forEach((el) => observer.observe(el));
}

/* =========================================
   University Stats Fetcher
   ========================================= */
function initUniversityStats() {
    const container = document.getElementById("stats-container");
    if (!container) return;

    // Placeholder logic handled in HTML. 
    // Here we simulate or fetch real stats.
    // Assuming standard CTFd doesn't have /api/stats by default, 
    // we might need to rely on the user to IMPLEMENT the backend or use a placeholder.

    // Real implementation:
    const fetchStats = async () => {
        try {
            const res = await fetch("/api/stats"); // This might 404 on vanilla CTFd
            if (!res.ok) throw new Error("API not found");
            const data = await res.json();
            renderStats(data);
        } catch (e) {
            console.warn("Stats API not found or failed, using placeholder data for demo or hiding.");
            // For demo purposes, if this fails, we might just hide the loading or show nothing
            // OR we can render some mock data if the user wants to see how it looks.
            // renderStats({ "UCSC": 45, "UoM": 32, "SLIIT": 28, "IIT": 15, "KDU": 10, "NSBM": 5 });
            container.innerHTML = '<p class="text-center text-dim">No stats available yet.</p>';
        }
    };

    // Intersection Observer to fetch only when visible
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            fetchStats();
            observer.disconnect();
        }
    }, { threshold: 0.1 });

    observer.observe(container);
}

function renderStats(data) {
    const container = document.getElementById("stats-container");
    if (!container) return;

    const items = Object.entries(data)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    if (items.length === 0) {
        container.innerHTML = '<p class="text-center text-dim">No registered participants yet.</p>';
        return;
    }

    const top3 = items.slice(0, 3);
    const rest = items.slice(3);

    let html = '';

    // Mobile View
    html += '<div class="block md:hidden space-y-4">';
    items.forEach(item => {
        html += `
      <div class="card-shell rounded-xl p-5 flex items-center justify-between">
         <div class="text-gold text-4xl font-semibold">${item.count}</div>
         <div class="w-px h-10 bg-white/10 mx-4"></div>
         <div class="flex-1 text-dim uppercase tracking-widest text-xs">${item.name}</div>
      </div>
     `;
    });
    html += '</div>';

    // Desktop View
    html += '<div class="hidden md:block">';

    // Top 3
    html += '<div class="grid-3 mb-6">';
    top3.forEach(item => {
        html += `
      <div class="card-shell featured-card">
        <div class="stat-count-lg">${item.count}</div>
        <div class="stat-divider"></div>
        <div class="stat-name">${item.name}</div>
      </div>
    `;
    });
    html += '</div>';

    // Rest
    if (rest.length > 0) {
        html += '<div class="grid-small">';
        rest.forEach(item => {
            html += `
          <div class="card-shell small-card">
            <div class="stat-count-md">${item.count}</div>
            <div class="stat-divider"></div>
            <div class="stat-name-sm">${item.name}</div>
          </div>
        `;
        });
        html += '</div>';
    }

    html += '</div>'; // end desktop

    container.innerHTML = html;
}
