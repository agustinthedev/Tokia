const BOUND_MARKER = '__tokiaPreviewGalleryBound__';

type GalleryDocument = Document & { [BOUND_MARKER]?: boolean };

function selectThumbnail(thumbnail: HTMLImageElement): void {
  const workspace = thumbnail.closest<HTMLElement>('.preview-workspace');
  const mainImage = workspace?.querySelector<HTMLImageElement>('.preview-main img');
  const strip = thumbnail.closest<HTMLElement>('.preview-strip');
  if (!mainImage || !strip) return;

  const source = thumbnail.currentSrc || thumbnail.getAttribute('src');
  if (!source) return;

  mainImage.src = source;
  mainImage.alt = thumbnail.alt || 'Selected preview';
  strip.querySelectorAll<HTMLImageElement>('img').forEach((item) => {
    item.classList.toggle('selected', item === thumbnail);
    item.toggleAttribute('aria-current', item === thumbnail);
  });
}

export function bindPreviewGallery(root: GalleryDocument): void {
  if (root[BOUND_MARKER]) return;
  root[BOUND_MARKER] = true;

  root.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.closest('.preview-strip')) {
      selectThumbnail(target);
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.closest('.preview-strip')) return;
    event.preventDefault();
    selectThumbnail(target);
  });
}
