$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$log = "$env:TEMP\nx_all.txt"
function Step($title, [scriptblock]$cmd) {
    "`n########## $title  $(Get-Date -Format HH:mm:ss)" | Out-File $log -Append -Encoding utf8
    & $cmd *>&1 | Out-File $log -Append -Encoding utf8
}

Step "1-tashkilot yillik tarixini olib tashlash" { python dbsize.py reset }
Step "indekslarsiz" { python idx.py drop }
Step "1 OY: yuklama 1x, 2x" { python -u load.py 120 1,2 }
Step "1 OY: to'lqin va o'qishlar" { python -u year.py probe month }
Step "1 YIL tarix qo'shish" { python -u year.py fill }
Step "1 YIL, indekssiz: to'lqin va o'qishlar" { python -u year.py probe year_noidx }
Step "1 YIL, indekssiz: yuklama 1x" { python -u load.py 120 1 }
Step "indekslar yaratish" { python idx.py create }
Step "1 YIL, indeks bilan: to'lqin va o'qishlar" { python -u year.py probe year_idx }
Step "1 YIL, indeks bilan: yuklama 1x" { python -u load.py 120 1 }
Step "baza hajmi" { python dbsize.py }
"`n########## TAYYOR $(Get-Date -Format HH:mm:ss)" | Out-File $log -Append -Encoding utf8
