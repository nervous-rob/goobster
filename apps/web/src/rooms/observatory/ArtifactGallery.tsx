import { fileName, parentDir, whenLabel } from './format';

export type ArtifactFile = {
    path: string;
    size: number;
    url?: string;
    isVideo?: boolean;
    isImage?: boolean;
    modifiedAt?: string;
};

export function ArtifactGallery({
    files,
    totalFiles,
    onBrowse
}: {
    files: ArtifactFile[];
    totalFiles?: number;
    onBrowse?: () => void;
}) {
    const videos = files.filter((file) => file.isVideo && file.url);
    const images = files.filter((file) => file.isImage && file.url);
    const mediaCount = videos.length + images.length;
    const hidden = Math.max(0, (totalFiles || files.length) - files.length);

    if (mediaCount === 0) {
        return (
            <section className="obs-artifacts">
                <div className="obs-section-head">
                    <h3>Artifacts</h3>
                </div>
                <p className="hint obs-artifacts-empty">
                    No renders or images in the workspace yet. Command Goobster to
                    produce some, or drop files in Explorer.
                </p>
            </section>
        );
    }

    const featured = videos[0];
    const extraVideos = videos.slice(1);

    return (
        <section className="obs-artifacts">
            <div className="obs-section-head">
                <h3>Artifacts</h3>
                <span className="hint">
                    {mediaCount} in this workspace
                    {hidden > 0 ? ` · ${hidden} more files in Explorer` : ''}
                </span>
            </div>
            <p className="hint obs-artifacts-lead">
                Latest renders and images. Paths stay in Explorer; this is the
                picture of what the project has made.
            </p>

            {featured && (
                <figure className="obs-artifact-feature">
                    <video className="obs-video" src={featured.url} controls preload="metadata" />
                    <figcaption>
                        <span className="badge">Latest render</span>
                        <span className="obs-artifact-name" title={featured.path}>{fileName(featured.path)}</span>
                        {featured.modifiedAt ? <span className="hint">{whenLabel(featured.modifiedAt)}</span> : null}
                    </figcaption>
                </figure>
            )}

            {(images.length > 0 || extraVideos.length > 0) && (
                <div className="obs-gallery">
                    {extraVideos.map((video) => (
                        <a
                            key={video.path}
                            href={video.url}
                            target="_blank"
                            rel="noopener"
                            title={video.path}
                            className="obs-gallery-card is-video"
                        >
                            <video src={video.url} preload="metadata" muted />
                            <span className="obs-gallery-meta">
                                <span className="badge">Video</span>
                                <span className="obs-artifact-name">{fileName(video.path)}</span>
                            </span>
                        </a>
                    ))}
                    {images.map((image) => (
                        <a
                            key={image.path}
                            href={image.url}
                            target="_blank"
                            rel="noopener"
                            title={image.path}
                            className="obs-gallery-card"
                        >
                            <img src={image.url} alt={fileName(image.path)} loading="lazy" />
                            <span className="obs-gallery-meta">
                                <span className="obs-artifact-name">{fileName(image.path)}</span>
                                {parentDir(image.path) ? (
                                    <span className="hint">{parentDir(image.path)}</span>
                                ) : null}
                            </span>
                        </a>
                    ))}
                </div>
            )}

            {onBrowse && (
                <button type="button" className="btn subtle obs-artifacts-more" onClick={onBrowse}>
                    Browse all files in Explorer
                </button>
            )}
        </section>
    );
}
