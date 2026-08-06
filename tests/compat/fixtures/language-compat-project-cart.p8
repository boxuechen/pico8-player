pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 local a,b,c=unpack({11,nil,33})
 assert(a==11 and b==nil and c==33)
 assert(select("#",unpack({1,2},2,1))==0)
 assert(⬅️==0 and ➡️==1 and ⬆️==2 and ⬇️==3 and 🅾️==4 and ❎==5)
 assert(█==0 and ▒==0x5a5a.8 and 🐱==0x511f.8 and ░==0x7d7d.8)
 assert(✽==0xb81d.8 and ●==0xf99f.8 and ♥==0x51bf.8 and ☉==0xb5bf.8)
 assert(웃==0x999f.8 and ⌂==0xb11f.8 and 😐==0xa0e0.8 and ♪==0x9b3f.8)
 assert(◆==0xb1bf.8 and …==0xf5ff.8 and ★==0xb15f.8 and ⧗==0x1b1f.8)
 assert(ˇ==0xf5bf.8 and ∧==0x7adf.8 and ▤==0x0f0f.8 and ▥==0x5555.8)
 ok=true
end

function _update()
end

function _draw()
 cls(ok and 11 or 8)
 print("phase 6g language",25,58,7)
 print("unpack+p8scii ok",29,66,7)
end
