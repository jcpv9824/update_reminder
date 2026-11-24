# Desarrollador · selector ERP y archivos privados

Esta entrega no cambia la publicación pública, no habilita reportes por correo
y no requiere reescribir la migración 062. El editor enriquecido se conserva.

## Flujo de autor

- **Cliente:** un único combobox. No consulta hasta tres caracteres útiles,
  busca automáticamente en el catálogo autorizado del ERP, y exige elegir una
  opción. Al editar conserva el cliente guardado mientras no se cambie. El
  servidor vuelve a verificar la opción antes de guardar.
- **Qué cambió:** se conserva la barra de formato. Insertar imagen, pegar una
  imagen del portapapeles y adjuntar documentos usan el mismo canal privado. Pegar
  inserta la imagen en el punto de pegado sin reemplazar el texto existente.
- **Reglas de negocio** y **Video de entrega** disponen de un botón «+» cada una.
  Cada zona admite varios enlaces HTTPS y/o archivos; un enlace no inicia una
  subida. Los campos se muestran en paralelo cuando hay espacio.
- La primera subida en un formulario nuevo guarda un **borrador** para obtener
  su identificador; no publica. La subida no reemplaza el texto. El autor debe
  guardar para vincular definitivamente el archivo con la entrada.

## Contrato y límites

`WHATS_NEW_MEDIA_ENABLED=true` es independiente de `WHATS_NEW_ENABLED`. Requiere
un proveedor SeaweedFS configurado. En QA se valida con un prefijo exclusivo
del entorno, nunca con el prefijo productivo. No se activa un destino nuevo
por defecto al desplegar. No se cambian credenciales, permisos ni App Settings
de terceros como parte de esta entrega.

El POST privado `/api/whats-new/entries/{id}/uploads` recibe multipart
`file`, `kind` y `target`; requiere Idempotency-Key. Tipos y límites:
imagen PNG/JPEG/GIF/WebP (5 MB), documento PDF/DOCX/XLSX (20 MB) y video MP4/WebM (30 MB).
Los documentos Office solo se almacenan y descargan: no se abren ni se
procesa su contenido en el servidor.
No se aceptan SVG ni HTML como adjuntos. Las zonas de reglas/video se limitan
al tipo de archivo que anuncian. El servidor valida el tamaño, la cabecera
binaria, el destino y los permisos; no confía en el MIME del navegador.
Hay un máximo de 48 registros de archivo por entrada, incluidas las cargas
pendientes o retiradas. Dos transferencias privadas simultáneas por instancia
es el límite de este canal HTTP; además se aplica límite por actor.

La subida confirma bytes y registra metadatos; un archivo todavía no vinculado
solo es visible al autor de la subida y vence para ese uso a las 24 horas.
Guardar texto/referencias promueve los archivos correspondientes en la
transacción del borrador o corrección; no acepta IDs de otra entrada. El GET
privado valida autorización, contenido/huella y tamaño antes de entregar
bytes. El editor serializa únicamente el ID de archivo y metadatos no sensibles;
para presentar imágenes y descargar adjuntos usa solicitudes autenticadas.
No persiste URL de objeto, SAS, credenciales ni contenido binario en SQL.

No se habilita limpieza física automática: una confirmación SQL incierta nunca
provoca que se borre un objeto potencialmente compartido. El lote de QA queda
identificado por su prefijo y por entradas sintéticas, sin usar registros de
producción. El mantenimiento de adjuntos sin referencia y retención para uso
extenso requiere un proceso separado, acotado y revisado; no borrar por prefijo
sin reconciliar referencias.

## Puertas de salida

1. Suite API y frontend del candidato, seguridad, builds y validación de
   desactivación pública.
2. QA con cuenta existente autorizada en Desarrollo: buscar desde tres letras;
   subir imagen, PDF y video, guardar y reabrir el borrador, descargar y cotejar
   hashes. Repetir una subida con la misma llave y rechazar lecturas/escrituras
   fuera de la entrada o sin sesión.
3. Mantener la publicación pública apagada y no llamar al flujo de correo.
   No promover el prefijo QA a producción.
4. Una vez certificada la entrega, publicar API antes de frontend; mantener un
   paquete anterior listo. Desactivar solo las nuevas subidas con
   `WHATS_NEW_MEDIA_ENABLED=false` no elimina objetos ni impide las lecturas
   privadas de los archivos ya guardados.

## Ensayo en QA · 24 de noviembre de 2026

`api/scripts/verify-whats-new-media-qa.cjs` ejecutó el ciclo privado en
`PortalSAGWeb-TEST` con una cuenta existente de Desarrollo. Se creó un único
borrador sintético; PNG, PDF y MP4 se subieron a SeaweedFS y se recuperaron con
el mismo SHA-256 tras reabrirlo. Tres reintentos con sus llaves originales
devolvieron los mismos identificadores. El texto conservó su formato y no
incluyó URLs de almacenamiento. Se verificó que la publicación siguiera
apagada; no se invocó el flujo de correo. El perfil QA regresó a su área previa.
El ensayo usa servicios reales, no reemplaza la verificación visual del
frontend alojado. La interacción de pegado y teclado se cubre con pruebas de
componentes.
