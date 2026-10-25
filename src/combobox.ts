import { searchStreets, type Street } from "./api";
import { qsa, escapeHtml, formatNeighborhoods } from "./utils";


export async function searchStreetsByTerm(term: string, limit = 8): Promise<Street[]> {
    try {
        return await searchStreets(term, limit);
    } catch (error) {
        console.error("Falha ao consultar logradouros:", error);
        return [];
    }
}

interface StreetComboboxOptions {
    inputEl: HTMLInputElement;
    suggestionsEl: HTMLElement;
    onSelect: (street: Street | null) => void;
}

export function initStreetCombobox({ inputEl, suggestionsEl, onSelect }: StreetComboboxOptions) {
    let debounceHandle: ReturnType<typeof setTimeout> | undefined;
    let activeIndex = -1;
    let currentMatches: Street[] = [];
    let selected: Street | null = null;

    function closeSuggestions() {
        suggestionsEl.innerHTML = "";
        suggestionsEl.classList.add("hidden");
        activeIndex = -1;
        currentMatches = [];
    }

    function updateActiveHighlight() {
        qsa<HTMLButtonElement>(".combobox-suggestion", suggestionsEl).forEach((btn, i) => {
            btn.classList.toggle("active", i === activeIndex);
        });
    }

    function renderSuggestions(matches: Street[]) {
        currentMatches = matches;
        activeIndex = -1;
        if (matches.length === 0) {
            suggestionsEl.innerHTML =
                '<div class="combobox-empty">Nenhum logradouro encontrado.</div>';
            suggestionsEl.classList.remove("hidden");
            return;
        }
        suggestionsEl.innerHTML = matches
            .map(
                (s, i) => `
      <button type="button" class="combobox-suggestion" data-index="${i}">
        <span class="combobox-suggestion-name">${escapeHtml(s.name)}</span>
        <span class="combobox-suggestion-sub">${escapeHtml(formatNeighborhoods(s.neighborhood))}</span>
      </button>
    `,
            )
            .join("");
        suggestionsEl.classList.remove("hidden");
    }

    function pick(street: Street) {
        selected = street;
        inputEl.value = street.name;
        closeSuggestions();
        onSelect(street);
    }

    inputEl.addEventListener("input", () => {
        if (selected && inputEl.value !== selected.name) {
            selected = null;
            onSelect(null);
        }
        if (debounceHandle !== undefined) clearTimeout(debounceHandle);
        const term = inputEl.value;
        debounceHandle = setTimeout(async () => {
            const matches = await searchStreetsByTerm(term);
            // Auto-select if exactly 1 result is returned
            if (matches.length === 1) {
                pick(matches[0]);
                return;
            }
            renderSuggestions(matches);
        }, 280);
    });

    inputEl.addEventListener("keydown", (e) => {
        if (
            suggestionsEl.classList.contains("hidden") ||
            currentMatches.length === 0
        )
            return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
            updateActiveHighlight();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActiveHighlight();
        } else if (e.key === "Enter") {
            if (activeIndex >= 0) {
                e.preventDefault();
                pick(currentMatches[activeIndex]);
            }
        } else if (e.key === "Escape") {
            closeSuggestions();
        }
    });

    suggestionsEl.addEventListener("click", (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest<HTMLButtonElement>(".combobox-suggestion");
        if (!btn) return;
        const match = currentMatches[Number(btn.dataset.index)];
        if (match) pick(match);
    });

    inputEl.addEventListener("blur", () => {
        setTimeout(closeSuggestions, 150);
    });

    return {
        setValue(street: Street | null) {
            selected = street;
            inputEl.value = street ? street.name : "";
            closeSuggestions();
        },
        getSelected() {
            return selected;
        },
    };
}