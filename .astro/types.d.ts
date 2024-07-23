declare module 'astro:content' {
	interface Render {
		'.mdx': Promise<{
			Content: import('astro').MarkdownInstance<{}>['Content'];
			headings: import('astro').MarkdownHeading[];
			remarkPluginFrontmatter: Record<string, any>;
		}>;
	}
}

declare module 'astro:content' {
	interface Render {
		'.md': Promise<{
			Content: import('astro').MarkdownInstance<{}>['Content'];
			headings: import('astro').MarkdownHeading[];
			remarkPluginFrontmatter: Record<string, any>;
		}>;
	}
}

declare module 'astro:content' {
	type Flatten<T> = T extends { [K: string]: infer U } ? U : never;

	export type CollectionKey = keyof AnyEntryMap;
	export type CollectionEntry<C extends CollectionKey> = Flatten<AnyEntryMap[C]>;

	export type ContentCollectionKey = keyof ContentEntryMap;
	export type DataCollectionKey = keyof DataEntryMap;

	type AllValuesOf<T> = T extends any ? T[keyof T] : never;
	type ValidContentEntrySlug<C extends keyof ContentEntryMap> = AllValuesOf<
		ContentEntryMap[C]
	>['slug'];

	export function getEntryBySlug<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {}),
	>(
		collection: C,
		// Note that this has to accept a regular string too, for SSR
		entrySlug: E
	): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;

	export function getDataEntryById<C extends keyof DataEntryMap, E extends keyof DataEntryMap[C]>(
		collection: C,
		entryId: E
	): Promise<CollectionEntry<C>>;

	export function getCollection<C extends keyof AnyEntryMap, E extends CollectionEntry<C>>(
		collection: C,
		filter?: (entry: CollectionEntry<C>) => entry is E
	): Promise<E[]>;
	export function getCollection<C extends keyof AnyEntryMap>(
		collection: C,
		filter?: (entry: CollectionEntry<C>) => unknown
	): Promise<CollectionEntry<C>[]>;

	export function getEntry<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {}),
	>(entry: {
		collection: C;
		slug: E;
	}): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof DataEntryMap,
		E extends keyof DataEntryMap[C] | (string & {}),
	>(entry: {
		collection: C;
		id: E;
	}): E extends keyof DataEntryMap[C]
		? Promise<DataEntryMap[C][E]>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {}),
	>(
		collection: C,
		slug: E
	): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof DataEntryMap,
		E extends keyof DataEntryMap[C] | (string & {}),
	>(
		collection: C,
		id: E
	): E extends keyof DataEntryMap[C]
		? Promise<DataEntryMap[C][E]>
		: Promise<CollectionEntry<C> | undefined>;

	/** Resolve an array of entry references from the same collection */
	export function getEntries<C extends keyof ContentEntryMap>(
		entries: {
			collection: C;
			slug: ValidContentEntrySlug<C>;
		}[]
	): Promise<CollectionEntry<C>[]>;
	export function getEntries<C extends keyof DataEntryMap>(
		entries: {
			collection: C;
			id: keyof DataEntryMap[C];
		}[]
	): Promise<CollectionEntry<C>[]>;

	export function reference<C extends keyof AnyEntryMap>(
		collection: C
	): import('astro/zod').ZodEffects<
		import('astro/zod').ZodString,
		C extends keyof ContentEntryMap
			? {
					collection: C;
					slug: ValidContentEntrySlug<C>;
				}
			: {
					collection: C;
					id: keyof DataEntryMap[C];
				}
	>;
	// Allow generic `string` to avoid excessive type errors in the config
	// if `dev` is not running to update as you edit.
	// Invalid collection names will be caught at build time.
	export function reference<C extends string>(
		collection: C
	): import('astro/zod').ZodEffects<import('astro/zod').ZodString, never>;

	type ReturnTypeOrOriginal<T> = T extends (...args: any[]) => infer R ? R : T;
	type InferEntrySchema<C extends keyof AnyEntryMap> = import('astro/zod').infer<
		ReturnTypeOrOriginal<Required<ContentConfig['collections'][C]>['schema']>
	>;

	type ContentEntryMap = {
		"docs": {
"404.mdx": {
	id: "404.mdx";
  slug: "404";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"AZ-107.mdx": {
	id: "AZ-107.mdx";
  slug: "az-107";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"ExamTemplate.md": {
	id: "ExamTemplate.md";
  slug: "examtemplate";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"azure/AI-102.mdx": {
	id: "azure/AI-102.mdx";
  slug: "azure/ai-102";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AI-900.mdx": {
	id: "azure/AI-900.mdx";
  slug: "azure/ai-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-104.mdx": {
	id: "azure/AZ-104.mdx";
  slug: "azure/az-104";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-120.mdx": {
	id: "azure/AZ-120.mdx";
  slug: "azure/az-120";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-140.mdx": {
	id: "azure/AZ-140.mdx";
  slug: "azure/az-140";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-204.mdx": {
	id: "azure/AZ-204.mdx";
  slug: "azure/az-204";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-305.md": {
	id: "azure/AZ-305.md";
  slug: "azure/az-305";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"azure/AZ-400.mdx": {
	id: "azure/AZ-400.mdx";
  slug: "azure/az-400";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-500.mdx": {
	id: "azure/AZ-500.mdx";
  slug: "azure/az-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-700.md": {
	id: "azure/AZ-700.md";
  slug: "azure/az-700";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"azure/AZ-800.mdx": {
	id: "azure/AZ-800.mdx";
  slug: "azure/az-800";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-801.mdx": {
	id: "azure/AZ-801.mdx";
  slug: "azure/az-801";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/AZ-900.mdx": {
	id: "azure/AZ-900.mdx";
  slug: "azure/az-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/DP-100.mdx": {
	id: "azure/DP-100.mdx";
  slug: "azure/dp-100";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/DP-203.mdx": {
	id: "azure/DP-203.mdx";
  slug: "azure/dp-203";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/DP-300.mdx": {
	id: "azure/DP-300.mdx";
  slug: "azure/dp-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/DP-420.md": {
	id: "azure/DP-420.md";
  slug: "azure/dp-420";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"azure/DP-500.mdx": {
	id: "azure/DP-500.mdx";
  slug: "azure/dp-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/DP-600.mdx": {
	id: "azure/DP-600.mdx";
  slug: "azure/dp-600";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"azure/DP-900.mdx": {
	id: "azure/DP-900.mdx";
  slug: "azure/dp-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"blog/newupdate.mdx": {
	id: "blog/newupdate.mdx";
  slug: "blog/newupdate";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"dynamics/MB-210.md": {
	id: "dynamics/MB-210.md";
  slug: "dynamics/mb-210";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-220.md": {
	id: "dynamics/MB-220.md";
  slug: "dynamics/mb-220";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-230.md": {
	id: "dynamics/MB-230.md";
  slug: "dynamics/mb-230";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-240.md": {
	id: "dynamics/MB-240.md";
  slug: "dynamics/mb-240";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-260.md": {
	id: "dynamics/MB-260.md";
  slug: "dynamics/mb-260";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-300.md": {
	id: "dynamics/MB-300.md";
  slug: "dynamics/mb-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-310.md": {
	id: "dynamics/MB-310.md";
  slug: "dynamics/mb-310";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-330.md": {
	id: "dynamics/MB-330.md";
  slug: "dynamics/mb-330";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-335.md": {
	id: "dynamics/MB-335.md";
  slug: "dynamics/mb-335";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-500.md": {
	id: "dynamics/MB-500.md";
  slug: "dynamics/mb-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-700.md": {
	id: "dynamics/MB-700.md";
  slug: "dynamics/mb-700";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-800.md": {
	id: "dynamics/MB-800.md";
  slug: "dynamics/mb-800";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"dynamics/MB-910.mdx": {
	id: "dynamics/MB-910.mdx";
  slug: "dynamics/mb-910";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"dynamics/MB-920.mdx": {
	id: "dynamics/MB-920.mdx";
  slug: "dynamics/mb-920";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/certificationdashboard.mdx": {
	id: "guide/certificationdashboard.mdx";
  slug: "guide/certificationdashboard";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/certificationrenewal.mdx": {
	id: "guide/certificationrenewal.mdx";
  slug: "guide/certificationrenewal";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/introduction.mdx": {
	id: "guide/introduction.mdx";
  slug: "guide/introduction";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/officialstudymaterials.mdx": {
	id: "guide/officialstudymaterials.mdx";
  slug: "guide/officialstudymaterials";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/overview.mdx": {
	id: "guide/overview.mdx";
  slug: "guide/overview";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/partneremployees.mdx": {
	id: "guide/partneremployees.mdx";
  slug: "guide/partneremployees";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/schedulingexam.mdx": {
	id: "guide/schedulingexam.mdx";
  slug: "guide/schedulingexam";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/studentopportunities.mdx": {
	id: "guide/studentopportunities.mdx";
  slug: "guide/studentopportunities";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"guide/takingtheexams.mdx": {
	id: "guide/takingtheexams.mdx";
  slug: "guide/takingtheexams";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"index.mdx": {
	id: "index.mdx";
  slug: "index";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"labs/AZ-107labs.mdx": {
	id: "labs/AZ-107labs.mdx";
  slug: "labs/az-107labs";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"labs/azurelabs.mdx": {
	id: "labs/azurelabs.mdx";
  slug: "labs/azurelabs";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"microsoft365/MD-102.mdx": {
	id: "microsoft365/MD-102.mdx";
  slug: "microsoft365/md-102";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"microsoft365/MS-102.mdx": {
	id: "microsoft365/MS-102.mdx";
  slug: "microsoft365/ms-102";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"microsoft365/MS-700.mdx": {
	id: "microsoft365/MS-700.mdx";
  slug: "microsoft365/ms-700";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"microsoft365/MS-721.mdx": {
	id: "microsoft365/MS-721.mdx";
  slug: "microsoft365/ms-721";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"microsoft365/MS-900.mdx": {
	id: "microsoft365/MS-900.mdx";
  slug: "microsoft365/ms-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"office/MO-110.md": {
	id: "office/MO-110.md";
  slug: "office/mo-110";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"office/MO-111.md": {
	id: "office/MO-111.md";
  slug: "office/mo-111";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"office/MO-210.md": {
	id: "office/MO-210.md";
  slug: "office/mo-210";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"office/MO-211.md": {
	id: "office/MO-211.md";
  slug: "office/mo-211";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"office/MO-310.md": {
	id: "office/MO-310.md";
  slug: "office/mo-310";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"power/PL-200.mdx": {
	id: "power/PL-200.mdx";
  slug: "power/pl-200";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"power/PL-300.mdx": {
	id: "power/PL-300.mdx";
  slug: "power/pl-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"power/PL-400.mdx": {
	id: "power/PL-400.mdx";
  slug: "power/pl-400";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"power/PL-500.mdx": {
	id: "power/PL-500.mdx";
  slug: "power/pl-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"power/PL-600.mdx": {
	id: "power/PL-600.mdx";
  slug: "power/pl-600";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"power/PL-900.mdx": {
	id: "power/PL-900.mdx";
  slug: "power/pl-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"security/SC-100.mdx": {
	id: "security/SC-100.mdx";
  slug: "security/sc-100";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"security/SC-200.mdx": {
	id: "security/SC-200.mdx";
  slug: "security/sc-200";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"security/SC-300.mdx": {
	id: "security/SC-300.mdx";
  slug: "security/sc-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"security/SC-400.mdx": {
	id: "security/SC-400.mdx";
  slug: "security/sc-400";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"security/SC-900.mdx": {
	id: "security/SC-900.mdx";
  slug: "security/sc-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"vouchers/betaexams.md": {
	id: "vouchers/betaexams.md";
  slug: "vouchers/betaexams";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"vouchers/cloudskillschallenges.mdx": {
	id: "vouchers/cloudskillschallenges.mdx";
  slug: "vouchers/cloudskillschallenges";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"vouchers/microsoftesi.md": {
	id: "vouchers/microsoftesi.md";
  slug: "vouchers/microsoftesi";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"vouchers/mindhubreplayvoucherbundles.md": {
	id: "vouchers/mindhubreplayvoucherbundles.md";
  slug: "vouchers/mindhubreplayvoucherbundles";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"vouchers/powerupprogram.md": {
	id: "vouchers/powerupprogram.md";
  slug: "vouchers/powerupprogram";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"vouchers/virtualtrainingdays.md": {
	id: "vouchers/virtualtrainingdays.md";
  slug: "vouchers/virtualtrainingdays";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"wiki.mdx": {
	id: "wiki.mdx";
  slug: "wiki";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
};

	};

	type DataEntryMap = {
		
	};

	type AnyEntryMap = ContentEntryMap & DataEntryMap;

	export type ContentConfig = typeof import("../src/content/config.js");
}
