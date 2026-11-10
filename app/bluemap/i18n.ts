import {createI18n} from 'vue-i18n';
import {nextTick} from "vue";
import {fetchHocon} from "./js/Utils";

/** An entry of "languages" in lang/settings.conf */
export interface LanguageInfo {
	locale: string;
	name: string;
}

/** lang/settings.conf */
export interface LanguageSettings {
	default: string;
	useBrowserLanguage: boolean;
	languages: LanguageInfo[];
}

export const i18nModule = createI18n({
	locale: 'none',
	fallbackLocale: 'en',
	silentFallbackWarn: true,
	warnHtmlMessage: false,
	legacy: false,
	messages: {}
});

/** The global composer, with the "languages" list that loadLanguageSettings() stores on it */
export type BlueMapI18n = typeof i18nModule.global & {
	languages?: LanguageInfo[];
};

export const i18n: BlueMapI18n = i18nModule.global;

export async function setLanguage(lang: string): Promise<void> {
	loadLanguage(lang);

	i18n.locale.value = lang;

	document.querySelector('html').setAttribute('lang', lang);

	return nextTick();
}

async function loadLanguage(lang: string): Promise<void> {
	try {
		if (!i18n.availableLocales.includes(lang)) {
			let messages = await fetchHocon(`./lang/${lang}.conf`);
			i18n.setLocaleMessage(lang, messages);
		}
	} catch (e) {
		console.error(`Failed to load language '${lang}'!`, e);
	}
}

export async function loadLanguageSettings(): Promise<void> {
	let settings: LanguageSettings = await fetchHocon(`./lang/settings.conf`);
	let selectedLanguage: string = null;

	if (settings.useBrowserLanguage) {
		const availableLanguages = settings.languages.map(lang => lang.locale);

		for (let browserLanguage of navigator.languages) {
			selectedLanguage = availableLanguages.find(lang => lang === browserLanguage);
			if (selectedLanguage) break;

			let baseBrowserLanguage = browserLanguage.split('-')[0];
			selectedLanguage = availableLanguages.find(lang => lang.startsWith(baseBrowserLanguage));
			if (selectedLanguage) break;
		}
	}

	if (!selectedLanguage) {
		selectedLanguage = settings.default;
	}

	await loadLanguage('en');
	await loadLanguage(settings.default);
	// assigns the property itself (not .value), as the original code did
	(i18nModule.global as unknown as { fallbackLocale: string[] }).fallbackLocale = [settings.default, 'en'];

	i18n.languages = settings.languages;
	await setLanguage(selectedLanguage);
}
