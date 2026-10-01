# Nexus Haydovchi — APK

Tayyor fayl: `Nexus-Haydovchi.apk` (loyiha ildizida). Telefonga nusxa qilib o‘rnating (Noma’lum manbalar ruxsatini yoqing).

Birinchi ochilishda server yozing, masalan:
`http://192.168.1.10:8000/driver/`

## APK ni koddan qayta yig‘ish

PowerShell:

```powershell
cd "C:\Users\Asus\OneDrive\Desktop\Новая папка\android-driver"
.\build-apk.bat
```

Yoki qo‘lda (JDK 17 va Android SDK o‘rnatilgan bo‘lsa):

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;" + $env:Path
cd android-driver
# local.properties ichida: sdk.dir=C:/Users/Asus/AppData/Local/Android/Sdk
& "$env:LOCALAPPDATA\NexusBuild\gradle-8.7\bin\gradle.bat" assembleDebug
```

Chiqgan fayl:
`android-driver\app\build\outputs\apk\debug\app-debug.apk`

## Android Studio orqali

1. Android Studio da `android-driver` papkasini oching.
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)**
3. APK: `app/build/outputs/apk/debug/app-debug.apk`

## Birinchi marta (agar SDK yo‘q bo‘lsa)

```powershell
winget install --id Microsoft.OpenJDK.17 -e --accept-package-agreements --accept-source-agreements
```

Android SDK:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root=$sdk "platforms;android-34" "build-tools;34.0.0" "platform-tools"
```

Papka nomida kirill harflar bo‘lsa `gradle.properties` da `android.overridePathCheck=true` qoldiring.
