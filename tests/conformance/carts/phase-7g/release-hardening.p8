pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
ticks=0
menu_hits=0

function _init()
 menuitem(1,"cycle palette",function()
  menu_hits+=1
  return false
 end)
end

function _update60()
 ticks+=1
end

function _draw()
 local base=menu_hits%4
 cls(base)
 for y=0,15 do
  for x=0,15 do
   if (x+y+flr(ticks/30))%2==0 then
    rectfill(x*8,y*8,x*8+7,y*8+7,(x+y+base)%16)
   end
  end
 end
 circfill(64+cos(ticks/120)*36,64+sin(ticks/120)*36,5,7)
 print("phase 7g",46,57,0)
 print("release hardening",30,65,0)
end
