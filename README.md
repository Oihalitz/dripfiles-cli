# DripFiles CLI

[![CI](https://github.com/Oihalitz/dripfiles-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Oihalitz/dripfiles-cli/actions/workflows/ci.yml)

Sube y descarga archivos de [DripFiles](https://dripfiles.com) sin salir de la terminal. No necesitas cuenta ni API key.

## Instalación

```bash
npm install --global dripfiles
dripfiles --help
```

Después de la instalación global, el ejecutable es `dripfiles` en Windows, macOS y Linux.
Ejecutarlo sin argumentos muestra la ayuda.

También puedes usarlo puntualmente, sin instalación global:

```bash
npx dripfiles archivo.zip
```

La primera ejecución de `npx` puede pedir confirmación para descargar el paquete. En CI puedes usar `npx --yes dripfiles archivo.zip`.

Requiere una versión mantenida de Node.js: Node 22 o posterior.

## Uso rápido

La forma corta detecta automáticamente qué quieres hacer:

```bash
# Una ruta local se sube; stdout contiene únicamente el enlace
dripfiles video.mp4
# https://dripfiles.com/AbC123

# Una URL se descarga en el directorio actual
dripfiles https://dripfiles.com/AbC123
# /ruta/actual/video.mp4
```

Puedes subir varios archivos en una sola transferencia:

```bash
dripfiles fotos.zip notas.pdf --message "Para el equipo"
```

Y usar comandos explícitos cuando quede más claro en un script:

```bash
dripfiles upload build.tar.gz
dripfiles download AbC123 --output ./descargas/
```

## Usar tu API key

Conecta una cuenta de DripFiles de forma interactiva:

```bash
dripfiles auth login
dripfiles auth status
dripfiles auth logout
```

La clave se valida antes de guardarse y se almacena en la carpeta de configuración del sistema con permisos restringidos. A partir del login, las subidas usan automáticamente los límites y la atribución de esa cuenta.

Para CI o uso temporal, evita guardar la clave:

```bash
DRIPFILES_API_KEY="df_..." dripfiles release.zip
DRIPFILES_API_KEY="df_..." dripfiles auth status
```

La API key no se acepta como argumento para evitar que aparezca en el historial del shell o en la lista de procesos.

## Opciones

```text
-m, --message <texto>    Mensaje de la transferencia
-o, --output <ruta>      Archivo o directorio de destino
-f, --force              Sobrescribe el archivo de destino
    --json               Salida JSON para scripts
-q, --quiet              No muestra estado ni progreso
    --no-progress        No muestra la barra de progreso
    --base-url <URL>     Usa otro servidor DripFiles
-h, --help               Ayuda
-v, --version            Versión
```

También puedes usar `dripfiles help`. La variable de entorno `DRIPFILES_BASE_URL` es equivalente a `--base-url`.

## Automatización

El progreso y los mensajes se escriben en stderr. Al subir, stdout solo contiene el enlace, así que se puede capturar directamente:

```bash
enlace="$(dripfiles release.zip)"
printf 'Descarga: %s\n' "$enlace"
```

Para una respuesta estructurada:

```bash
dripfiles upload release.zip --json
dripfiles download AbC123 --json --output ./release.zip
```

Los archivos se descargan primero con la extensión `.part` y se renombran al terminar. La CLI evita sobrescribir archivos existentes salvo que indiques `--force`.

## Límites de la API gratuita

- 2 GB por archivo.
- 10 GB por transferencia.
- Hasta 50 archivos.
- Los enlaces gratuitos caducan a los 2 días.

La CLI usa los chunks indicados por el servidor y reintenta fallos temporales automáticamente.
Con una API key se aplican en su lugar los límites de la cuenta conectada.

## Sistemas compatibles

- Windows.
- macOS, tanto Intel como Apple Silicon.
- Linux.

El paquete no ejecuta comandos específicos del sistema ni tiene dependencias nativas. Los nombres recibidos al descargar se limpian para evitar caracteres y nombres reservados incompatibles con Windows.

## Desarrollo

```bash
npm test
npm run check
npm pack --dry-run
```

## Licencia

MIT
