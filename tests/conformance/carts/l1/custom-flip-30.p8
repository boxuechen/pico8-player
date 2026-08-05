pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-owned phase 1f conformance cart
n=0

while true do
 cls(3)
 pset(n,8,7)
 pset(btn(1) and 1 or 0,16,11)
 pset(flr(time()*30+0.5),24,12)
 flip()
 n+=1
 if btn(1) then n+=1 end
end
