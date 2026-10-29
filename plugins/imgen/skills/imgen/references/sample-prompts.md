# 完整 prompt 范例（可直接复制）

这些是**完整的 prompt 配方**，不是"每次都要补这么多"的默认增补量。

改造用户提示时：
- 保留用户提出的全部要求
- 只按 `SKILL.md` 里的增补尺度补细节
- 不要把范例当成"可以随便编额外故事元素"的许可

标签行是 prompt 脚手架，不是封闭 schema。`Asset type`、`Input images`
只是 prompt 里的说明行，**imgen 没有对应的命令行开关**。

执行细节（`-s` / `-q` / `-b` / 输出路径）见 `imgen-cli.md`。

## Generate

### photorealistic-natural
```
Use case: photorealistic-natural
Primary request: candid photo of an elderly sailor on a small fishing boat adjusting a net
Scene/backdrop: coastal water with soft haze
Subject: weathered skin with wrinkles and sun texture
Style/medium: photorealistic candid photo
Composition/framing: medium close-up, eye-level
Lighting/mood: soft coastal daylight, shallow depth of field, subtle film grain
Materials/textures: real skin texture, worn fabric, salt-worn wood
Constraints: natural color balance; no heavy retouching; no glamorization; no watermark
Avoid: studio polish; staged look
```

### product-mockup
```
Use case: product-mockup
Primary request: premium product photo of a matte black shampoo bottle with a minimal label
Scene/backdrop: clean studio gradient from light gray to white
Subject: single bottle centered with subtle reflection
Style/medium: premium product photography
Composition/framing: centered, slight three-quarter angle, generous padding
Lighting/mood: softbox lighting, clean highlights, controlled shadows
Materials/textures: matte plastic, crisp label printing
Constraints: no logos or trademarks; no watermark
```

### ui-mockup
```
Use case: ui-mockup
Primary request: mobile app home screen for a local farmers market with vendors and daily specials
Asset type: mobile app screen
Style/medium: realistic product UI, not concept art
Composition/framing: clean vertical mobile layout with clear hierarchy
Constraints: practical layout, clear typography, no logos or trademarks, no watermark
```

### infographic-diagram
```
Use case: infographic-diagram
Primary request: detailed infographic of an automatic coffee machine flow
Scene/backdrop: clean, light neutral background
Subject: bean hopper -> grinder -> brew group -> boiler -> water tank -> drip tray
Style/medium: clean vector-like infographic with clear callouts and arrows
Composition/framing: vertical poster layout, top-to-bottom flow
Text (verbatim): "Bean Hopper", "Grinder", "Brew Group", "Boiler", "Water Tank", "Drip Tray"
Constraints: clear labels, strong contrast, no logos or trademarks, no watermark
```

### scientific-educational
```
Use case: scientific-educational
Primary request: biology diagram titled "Cellular Respiration at a Glance" for high school students
Scene/backdrop: clean white classroom handout background
Subject: glucose turns into energy inside a cell; include glycolysis, Krebs cycle, and electron transport chain
Style/medium: flat scientific diagram with consistent icons, arrows, and readable labels
Composition/framing: landscape slide-style layout with clear hierarchy and generous whitespace
Text (verbatim): "Cellular Respiration at a Glance", "Glucose", "Pyruvate", "ATP", "NADH", "FADH2", "CO2", "H2O", "O2"
Constraints: scientifically plausible; avoid tiny text; no extra decoration; no watermark
```

### logo-brand
```
Use case: logo-brand
Primary request: original logo for "Field & Flour", a local bakery
Style/medium: vector logo mark; flat colors; minimal
Composition/framing: single centered logo on a plain background with generous padding
Constraints: strong silhouette, balanced negative space; original design only; no gradients unless essential; no trademarks; no watermark
```

### illustration-story
```
Use case: illustration-story
Primary request: 4-panel comic about a pet left alone at home
Scene/backdrop: cozy living room across panels
Subject: pet reacting to the owner leaving, then relaxing, then returning to a composed pose
Style/medium: comic illustration with clear panels
Composition/framing: 4 equal-sized vertical panels, readable actions per panel
Constraints: no text; no logos or trademarks; no watermark
```

### stylized-concept
```
Use case: stylized-concept
Primary request: cavernous hangar interior with tall support beams and drifting fog
Scene/backdrop: industrial hangar interior, deep scale, light haze
Subject: compact shuttle parked near the center
Style/medium: cinematic concept art, industrial realism
Composition/framing: wide-angle, low-angle
Lighting/mood: volumetric light rays cutting through fog
Constraints: no logos or trademarks; no watermark
```

### ads-marketing
```
Use case: ads-marketing
Primary request: campaign image for a streetwear brand called Thread
Subject: group of friends hanging out together in a stylish urban setting
Style/medium: polished youth streetwear campaign photography
Composition/framing: vertical ad layout with natural poses and integrated headline space
Lighting/mood: contemporary, energetic, tasteful
Text (verbatim): "Yours to Create."
Constraints: render the tagline exactly once; clean legible typography; no extra text; no watermarks; no unrelated logos
```

### productivity-visual
```
Use case: productivity-visual
Primary request: one pitch-deck slide titled "Market Opportunity"
Asset type: fundraising slide image
Style/medium: clean modern deck slide, white background, crisp sans-serif typography
Subject: TAM/SAM/SOM concentric-circle diagram plus a small growth bar chart from 2021 to 2026
Composition/framing: 16:9 landscape slide, clear data hierarchy, polished spacing
Text (verbatim): "Market Opportunity", "TAM: $42B", "SAM: $8.7B", "SOM: $340M", "AGI Research, 2024", "Internal analysis"
Constraints: readable labels, no clip art, no stock photography, no decorative clutter, no watermark
```

### historical-scene
```
Use case: historical-scene
Primary request: outdoor crowd scene in Bethel, New York on August 16, 1969
Scene/backdrop: open field with period-appropriate staging
Subject: crowd in period-accurate clothing, authentic environment
Style/medium: photorealistic photo
Composition/framing: wide shot, eye-level
Constraints: period-accurate details; no modern objects; no logos or trademarks; no watermark
```

## 按资产类型的模板

### 网页素材模板
```
Use case: <photorealistic-natural|stylized-concept|product-mockup|infographic-diagram|ui-mockup>
Asset type: <hero image / section illustration / blog header>
Primary request: <简短描述>
Scene/backdrop: <环境或抽象背景>
Subject: <主体>
Style/medium: <照片/插画/3D>
Composition/framing: <wide/centered；只在需要时注明留白>
Lighting/mood: <soft/bright/neutral>
Color palette: <品牌色或中性色>
Constraints: <no text; no logos; no watermark; 需要时给 UI 留位置>
```

### 网页素材范例：极简 hero 背景
```
Use case: stylized-concept
Asset type: landing page hero background
Primary request: minimal abstract background with a soft gradient and subtle texture
Style/medium: matte illustration / soft-rendered abstract background
Composition/framing: wide composition with usable negative space for page copy
Lighting/mood: gentle studio glow
Color palette: restrained neutral palette
Constraints: no text; no logos; no watermark
```

### 网页素材范例：功能区插画
```
Use case: stylized-concept
Asset type: feature section illustration
Primary request: simple abstract shapes suggesting connection and flow
Scene/backdrop: subtle light-gray backdrop with faint texture
Style/medium: flat illustration; soft shadows; restrained contrast
Composition/framing: centered cluster; open margins for UI
Color palette: muted neutral palette
Constraints: no text; no logos; no watermark
```

### 网页素材范例：博客头图
```
Use case: photorealistic-natural
Asset type: blog header image
Primary request: overhead desk scene with notebook, pen, and coffee cup
Scene/backdrop: warm wooden tabletop
Style/medium: photorealistic photo
Composition/framing: wide crop with clean room for page copy
Lighting/mood: soft morning light
Constraints: no text; no logos; no watermark
```

### 游戏素材模板
```
Use case: stylized-concept
Asset type: <game environment concept art / game character concept / game UI icon / tileable game texture>
Primary request: <biome/scene/character/icon/material>
Scene/backdrop: <location + set dressing> (if applicable)
Subject: <main focal element(s)>
Style/medium: <realistic/stylized>; <concept art / character render / UI icon / texture>
Composition/framing: <wide/establishing/top-down>; <camera angle>; <focal point placement>
Lighting/mood: <time of day>; <mood>; <volumetric/fog/etc>
Constraints: no logos or trademarks; no watermark
```

### 游戏素材范例：环境概念图
```
Use case: stylized-concept
Asset type: game environment concept art
Primary request: cavernous hangar interior with tall support beams and drifting fog
Scene/backdrop: industrial hangar interior, deep scale, light haze
Subject: compact shuttle parked near the center
Style/medium: cinematic concept art, industrial realism
Composition/framing: wide-angle, low-angle
Lighting/mood: volumetric light rays cutting through fog
Constraints: no logos or trademarks; no watermark
```

### 游戏素材范例：角色概念图
```
Use case: stylized-concept
Asset type: game character concept
Primary request: desert scout character with layered travel gear
Subject: long coat, satchel, practical travel clothing
Style/medium: character render; stylized realism
Composition/framing: neutral hero pose on a simple backdrop
Constraints: no logos or trademarks; no watermark
```

### 游戏素材范例：UI 图标
```
Use case: stylized-concept
Asset type: game UI icon
Primary request: round shield icon with a subtle rune pattern
Style/medium: painted game UI icon
Composition/framing: centered icon; generous padding; clear silhouette
Constraints: no text; no background scene elements; no logos or trademarks; no watermark
```

### 游戏素材范例：可平铺贴图
```
Use case: stylized-concept
Asset type: tileable game texture
Primary request: worn sandstone blocks
Style/medium: seamless tileable texture; PBR-ish look
Scene/backdrop: neutral lighting reference only
Constraints: seamless edges; no obvious focal elements; no text; no logos or trademarks; no watermark
```

### 线框图模板
```
Use case: ui-mockup
Asset type: website wireframe
Primary request: <page or flow to sketch>
Style/medium: low-fi grayscale wireframe
Composition/framing: <landscape or portrait to match expected device>
Subject: <sections in order; grid/columns; key labels>
Constraints: no color; no logos; no real photos; no watermark
```

### 线框图范例：桌面首页
```
Use case: ui-mockup
Asset type: website wireframe
Primary request: SaaS homepage layout with clear hierarchy
Style/medium: low-fi grayscale wireframe
Subject: top nav; hero with headline and CTA; three feature cards; testimonial strip; pricing preview; footer
Composition/framing: landscape desktop layout
Constraints: label major blocks; no color; no logos; no real photos; no watermark
```

### 线框图范例：定价页
```
Use case: ui-mockup
Asset type: website wireframe
Primary request: pricing page layout with comparison table
Style/medium: low-fi grayscale wireframe
Subject: header; plan toggle; 3 pricing cards; comparison table; FAQ accordion; footer
Composition/framing: desktop or tablet layout
Constraints: label key areas; no color; no logos; no real photos; no watermark
```

### 线框图范例：移动端引导流程
```
Use case: ui-mockup
Asset type: mobile onboarding wireframe
Primary request: three-screen mobile onboarding flow
Style/medium: low-fi grayscale wireframe
Subject: screen 1 headline and CTA; screen 2 feature bullets; screen 3 form fields and CTA
Composition/framing: portrait mobile layout
Constraints: label screens and blocks; no color; no logos; no real photos; no watermark
```

### Logo 模板
```
Use case: logo-brand
Asset type: logo concept
Primary request: <brand idea or symbol concept>
Style/medium: vector logo mark; flat colors; minimal
Composition/framing: centered mark; clear silhouette; generous margin
Color palette: <1-2 colors; high contrast>
Text (verbatim): "<exact name>" (only if needed)
Constraints: no gradients; no mockups; no 3D; no watermark
```

### Logo 范例：抽象符号
```
Use case: logo-brand
Asset type: logo concept
Primary request: geometric leaf symbol suggesting sustainability and growth
Style/medium: vector logo mark; flat colors; minimal
Composition/framing: centered mark; clear silhouette
Color palette: deep green and off-white
Constraints: no text unless requested; no gradients; no mockups; no 3D; no watermark
```

### Logo 范例：字母组合
```
Use case: logo-brand
Asset type: logo concept
Primary request: interlocking monogram of the letters "AV"
Style/medium: vector logo mark; flat colors; minimal
Composition/framing: centered mark; balanced spacing
Color palette: black on white
Constraints: no gradients; no mockups; no 3D; no watermark
```

### Logo 范例：文字标
```
Use case: logo-brand
Asset type: logo concept
Primary request: clean wordmark for a modern studio
Style/medium: vector wordmark; flat colors; minimal
Text (verbatim): "Studio North"
Composition/framing: centered text; even letter spacing
Constraints: no gradients; no mockups; no 3D; no watermark
```

## Edit

### text-localization
```
Use case: text-localization
Input images: Image 1: original infographic
Primary request: replace "Bean Hopper", "Grinder", "Brew Group", "Boiler", "Water Tank", and "Drip Tray" with "Tolva", "Molino", "Grupo de infusión", "Caldera", "Depósito de agua", and "Bandeja de goteo"
Constraints: change only the text; preserve layout, typography, spacing, and hierarchy; no extra words; do not alter logos or imagery
```

### identity-preserve
```
Use case: identity-preserve
Input images: Image 1: person photo; Image 2..N: clothing references
Primary request: replace only the clothing with the provided garments
Constraints: preserve face, body shape, pose, hair, expression, and identity; match lighting and shadows; keep the background unchanged; no accessories or text
```

### precise-object-edit
```
Use case: precise-object-edit
Input images: Image 1: room photo
Primary request: replace only the white chairs with wooden chairs
Constraints: preserve camera angle, room lighting, floor shadows, and surrounding objects; keep all other aspects unchanged
```

### lighting-weather
```
Use case: lighting-weather
Input images: Image 1: original photo
Primary request: make it look like a winter evening with gentle snowfall
Constraints: preserve subject identity, geometry, camera angle, and composition; change only lighting, atmosphere, and weather
```

### style-transfer
```
Use case: style-transfer
Input images: Image 1: style reference
Primary request: apply Image 1's visual style to a man riding a motorcycle on a plain white backdrop
Constraints: preserve palette, texture, and brushwork; no extra elements
```

### compositing
```
Use case: compositing
Input images: Image 1: base scene; Image 2: subject to insert
Primary request: place the subject from Image 2 next to the person in Image 1
Constraints: match lighting, perspective, and scale; keep the base framing unchanged; no extra elements
```

### 角色一致性工作流
```
Use case: identity-preserve
Input images: Image 1: previous character anchor illustration
Primary request: continue the story with the same character in a new scene and action
Scene/backdrop: snowy forest after a winter storm
Subject: same young forest hero gently helping a frightened squirrel out of a fallen tree
Style/medium: same children's book watercolor illustration style as Image 1
Constraints: do not redesign the character; preserve facial features, proportions, outfit, color palette, and personality; no text; no watermark
```

### sketch-to-render
```
Use case: sketch-to-render
Input images: Image 1: drawing
Primary request: turn the drawing into a photorealistic image
Constraints: preserve layout, proportions, and perspective; choose realistic materials and lighting; do not add new elements or text
```

## 透明背景范例（贴纸 / 抠图）

```
Use case: background-extraction
Asset type: sticker
Primary request: a cute cartoon cat sticker, bold clean outline, centered with generous padding
Style/medium: flat vector sticker style
Constraints: transparent background; no shadow baked in; no background scene elements; no text; no watermark
```

执行时加 `-b transparent`。
