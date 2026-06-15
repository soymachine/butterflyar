# 🦋 Mariposa AR

Aplicación web de realidad aumentada para móviles. Una mariposa 3D revolotea
sobre la imagen de la cámara y reacciona a los gestos de tu mano.

## Cómo funciona

- **Cámara**: la app pide acceso a la cámara del teléfono y la muestra a pantalla completa.
- **Mariposa**: una mariposa 3D (three.js) vuela de forma aleatoria por la pantalla.
- **Detección de manos**: se usa [MediaPipe Hands](https://developers.google.com/mediapipe) para detectar la mano y los gestos.

### Gestos

| Gesto | Icono | Comportamiento |
|-------|-------|----------------|
| 🖐️ Mano abierta | palma | La mariposa vuela hasta el centro de la palma, desaparece y aparece una **mariposa de cristal** que gira sobre sí misma siguiendo la mano. |
| 👉 Dedo apuntando | dedo | La mariposa vuela hasta la **punta del dedo** y descansa ahí; si mueves el dedo, vuela a la nueva posición. |

Al dejar de hacer el gesto, la mariposa vuelve a revolotear libremente.

## Ejecutar

Es un sitio estático (HTML + JS por CDN). Necesita **HTTPS** para acceder a la
cámara, por lo que GitHub Pages es ideal.

### Local
```bash
# Cualquier servidor estático sirve, p.ej.:
python3 -m http.server 8000
# Luego abre https://localhost:8000 (o usa ngrok para HTTPS en el móvil)
```

### GitHub Pages
El workflow `.github/workflows/pages.yml` publica automáticamente la rama `main`.
Activa Pages en *Settings → Pages → Source: GitHub Actions*.

## Tecnología

- [three.js](https://threejs.org/) — render 3D y material de vidrio (`MeshPhysicalMaterial` con `transmission`).
- [MediaPipe Hands](https://github.com/google/mediapipe) — detección de mano y gestos.
- `getUserMedia` — acceso a la cámara.
