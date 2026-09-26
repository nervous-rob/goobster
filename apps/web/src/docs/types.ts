export type DocHeading = { level: number; title: string; anchor: string };
export type DocSection = { anchor: string; heading: string; text: string };
export type DocPage = {
    id: string; title: string; source: string; sourceUrl: string; group: string;
    html: string; headings: DocHeading[]; sections: DocSection[];
};
export type DocCorpus = {
    revision: string | null;
    groups: { title: string; ids: string[] }[];
    pages: DocPage[];
};
