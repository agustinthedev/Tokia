# Captions

## Objetivo

Captions es una biblioteca local para guardar, organizar y reutilizar textos
de publicaciones. La experiencia combina carpetas tipo Google Drive con
ficheros de texto editables y una acción opcional para generar un nuevo caption
con AI a partir de ejemplos existentes.

## Requerimientos funcionales

1. La navegación principal debe incluir una página `Captions`.
2. La página principal debe listar las carpetas activas en un formato de
   archivos/carpetas, sin imagen de portada.
3. El usuario debe poder crear una carpeta indicando:
   - título obligatorio;
   - subtítulo opcional;
   - color obligatorio con un valor hexadecimal válido.
4. Al abrir una carpeta se deben listar sus captions guardados como tarjetas o
   ficheros con icono de notepad. El nombre visible se deriva del comienzo del
   caption y no requiere un título adicional.
5. El usuario debe poder crear un caption indicando el texto y su color.
6. El cuerpo del caption debe persistir y mostrarse conservando saltos de línea,
   espacios relevantes y texto Unicode.
7. Al seleccionar un fichero se debe abrir el mismo editor en modo edición y
   guardar los cambios de texto y color de forma persistente.
8. Dentro de una carpeta debe existir una acción para elegir un caption al azar
   de esa carpeta y abrirlo en el editor.
9. Dentro de una carpeta debe existir una acción para generar un caption con AI.
   La generación debe recibir el prompt breve del usuario y hasta 30 captions
   de la carpeta como ejemplos de contexto.
10. El caption generado debe abrirse en el editor de creación como un borrador;
    no se debe persistir hasta que el usuario lo confirme.
11. Si no hay un proveedor de generación de texto conectado, la acción AI debe
    seguir visible pero desactivada y mostrar una explicación no intrusiva.

## Requerimientos técnicos

- Persistir carpetas y captions en SQLite mediante una migración versionada.
- Aislar los captions por `folder_id` y eliminar sus registros al eliminarse la
  carpeta mediante una relación con `ON DELETE CASCADE`.
- Exponer endpoints separados para carpetas, captions y generación AI. Las
  mutaciones deben requerir el token de integración local existente.
- Validar en backend límites de tamaño, campos obligatorios y colores; nunca
  confiar sólo en la validación del navegador.
- Usar la asignación AI existente de `TOPIC_DETECTION` únicamente cuando el
  proveedor esté conectado y tenga capacidad de generación de texto.
- Limitar el contexto de ejemplos a 30 captions y truncar cada ejemplo para
  mantener controlado el tamaño de la solicitud al proveedor.
- No persistir credenciales ni enviar secretos al navegador. Las respuestas AI
  deben normalizarse y validarse antes de entregarse al frontend.

## API propuesta

- `GET /api/caption-folders`
- `POST /api/caption-folders`
- `PATCH /api/caption-folders/:id`
- `GET /api/caption-folders/:id`
- `GET /api/caption-folders/:id/captions`
- `POST /api/caption-folders/:id/captions`
- `POST /api/caption-folders/:id/captions/generate`
- `GET /api/captions/ai-status`
- `PATCH /api/captions/:id`

Las respuestas usan nombres en camelCase, igual que los recursos existentes.
Los captions se devuelven con su cuerpo completo; el frontend deriva el título
visible con una vista previa acotada.

## Criterios de aceptación

- Crear una carpeta, recargar la página y verla nuevamente con su subtítulo,
  color y contador actualizado.
- Crear y editar un caption con varias líneas; después de recargar, los enters
  siguen presentes tanto en el editor como en la tarjeta.
- El selector aleatorio sólo abre captions de la carpeta actual.
- La generación usa el prompt ingresado, no falla si la carpeta no tiene
  ejemplos y limita el contexto a 30 ejemplos.
- Un resultado AI se puede modificar y descartar sin crear un registro; sólo el
  botón de guardar lo persiste.
- Sin proveedor conectado, la API informa que AI no está disponible y la UI no
  permite iniciar la acción.
- Las pruebas de API cubren validación, persistencia, separación por carpeta,
  preservación de saltos de línea y el camino de generación con un proveedor
  simulado.

## Fuera de alcance inicial

Compartir carpetas, subcarpetas anidadas, búsqueda global de captions, historial
de versiones, importación masiva, títulos manuales por caption y eliminación
desde la UI. Se pueden añadir posteriormente sin cambiar el contrato básico de
texto y color.
